// 地面敌人的「跳平台」导航（纯服务器端）。
//
// 修的问题：玩家跳到平台上后，地面怪只会沿着平台底下左右蹭，永远摸不到人。
// 做法：
//   1) 在当前能走到的范围内挑一个起跳点 + 目标平台落点（可以一级一级往上爬）；
//   2) 一段跳不够高时，在抛物线顶点附近自动补一段二段跳；
//   3) 正对着平台底面起跳只会顶头，所以先把落点/起跳点选在平台侧边外；
//   4) 上升途中把目标平台当柱子挡一下（见 shared/physics.js 的 ledge 参数），
//      否则斜着插进平台底面会被判成撞天花板，二段跳白送给物理；
//   5) 撞墙、被击飞、掉出场外都有兜底，不会死锁。
//
// 跳跃的重力/初速度全部来自 shared/constants.js 的 PHYS，和玩家共用一套物理，
// 所以「玩家跳得上来的平台，敌人也算得出跳得上来」。
import { PHYS } from '../../../shared/constants.js';
import { apexRise, aabb, clamp, rectFree, supportUnder } from '../../../shared/physics.js';

export const NAV = {
  landMargin: 6,     // 落点（身体中心）离平台边缘的安全距离
  stepUp: 14,        // 这么矮的台阶直接走上去就行，不用跳
  reachGrace: 8,     // 「跳得到」判定里的宽容度（二段跳不可能永远卡在完美顶点，留点余量）
  ledgeGrab: 14,     // 差这么点高度就一把扒上平台边缘
  planEvery: 0.10,   // 落地后重算跳板计划的最小间隔（秒）
  jumpCd: 0.18,      // 起跳后的硬冷却
  failCd: 0.42,      // 这跳没站上目标平台时的惩罚冷却（防原地抽搐）
  takeoffTol: 14,    // 走到起跳点允许的误差（同侧允许走过头，所以只用来兜住「还没到」）
  edgeGap: 1,        // 起跳点离平台边缘至少要留这么多
  maxSolidH: 160,    // 比这还厚的块当成墙/地板，不当跳板
  planRange: 640,    // 只为水平 640px 内的玩家规划跳板
  blockedHold: 0.22, // 撞墙后认为「被挡住」的持续时间
  airBoost: 1.15,    // 起跳时水平速度的下限（相对地面移速）
  airChase: 0.45,    // 起跳后多久内允许略高于地面移速
  airChaseMul: 1.3,  // 空中追平台的限速倍率
  doubleAtVel: 150,  // 竖直速度回落到 -150 以内（接近顶点）才允许交二段跳
  walkCost: 0.5,     // 计划打分里「走过去」的成本权重
};

/** 该敌人的跳跃能力：一段跳初速 / 二段跳初速 / 最多几跳 */
export function jumpPower(e) {
  const j = e.jump || {};
  const mul = j.mul ?? 1;
  return {
    vel: (j.vel ?? PHYS.jumpVel) * mul,
    dbl: (j.dbl ?? PHYS.doubleJumpVel) * mul,
    maxJumps: j.jumps ?? PHYS.maxJumps,
  };
}

/** 站在 (x, feet) 处是否站得下（身体有净空 + 脚下有实地） */
function standable(solids, x, feet, w, h) {
  if (!rectFree(solids, { x: x - w / 2, y: feet - h - 1, w, h: h + 1 })) return false;
  const probe = { x: x - w / 2 + 2, y: feet + 2, w: w - 4, h: 14 };
  for (let i = 0; i < solids.length; i++) if (aabb(probe, solids[i])) return true;
  return false;
}

/** 这一跳的滞空时间（近似），用来估算水平能飘多远 */
function airTime(nav, rise, maxJumps) {
  const g = PHYS.gravity;
  let peak = apexRise(nav.vel, g);
  let t = nav.vel / g;
  if (rise > peak && maxJumps >= 2) {
    t += nav.dbl / g;
    peak += apexRise(nav.dbl, g);
  }
  return t + Math.sqrt(Math.max(0, 2 * (peak - rise) / g));
}

/** 起跳点到落点之间（身体那一列）有没有别的东西挡着 */
function pathClear(solids, e, fromX, top, feet, skipA, skipB) {
  const r = { x: fromX - e.w / 2 + 1, y: top - e.h - 2, w: e.w - 2, h: feet - top + e.h + 2 };
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (s === skipA || s === skipB) continue;
    if (aabb(r, s)) return false;
  }
  return true;
}

/**
 * 挑一块跳板：返回 { top, landX, approachX, clearX, side, rise, needDouble, solid }。
 * approachX 可能还在路上（先走过去再跳），到位了 navThink 才会批准起跳。
 * 返回 null 表示「不用跳」或者「这高度差在这层楼根本跳不上去」。
 */
export function planHop(game, e, target, nav) {
  if (!target) return null;
  const solids = game.solids;
  const ecx = e.x + e.w / 2, feet = e.y + e.h;
  const tcx = target.x + target.w / 2, tFeet = target.y + target.h;
  if (feet - tFeet < NAV.stepUp) return null;                 // 玩家没比它高多少，直接走
  if (Math.abs(tcx - ecx) > NAV.planRange) return null;

  const sup = supportUnder(solids, e);                        // 当前踩着的东西，决定它能走到哪儿
  if (sup && sup === supportUnder(solids, target)) return null; // 已经在同一块平台上，追人就行

  const riseOne = apexRise(nav.vel);
  const riseMax = nav.maxJumps >= 2 ? riseOne + apexRise(nav.dbl) : riseOne;
  const here = Math.abs(tcx - ecx) + 1.3 * Math.abs(tFeet - feet);
  // 站在当前这块平台上能走到的 x 范围（允许身体压出边缘一点，贴边起跳更常见也更划算）
  const over = e.w * 0.25;
  const walkLo = sup ? sup.x - over : 0;
  const walkHi = sup ? sup.x + sup.w + over : game.level.width;
  let best = null;

  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (s.h > NAV.maxSolidH) continue;                         // 围墙/地板不是跳板
    const top = s.y, rise = feet - top;
    if (rise < NAV.stepUp || rise > riseMax - NAV.reachGrace) continue;
    // 落点按「身体中心」取值：中心在台面内就会被 AABB 解算接住，所以只需要离边缘留点余量
    const lo = s.x + NAV.landMargin, hi = s.x + s.w - NAV.landMargin;
    if (hi < lo) continue;                                     // 太窄站不下
    const idealLand = clamp(tcx, lo, hi);                      // 最理想的落点：玩家正上方
    const travel = Math.max(e.speed, 90) * airTime(nav, rise, nav.maxJumps);

    // 左右两侧各试一次：站到哪条边外起跳更划算
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      const edge = side < 0 ? s.x : s.x + s.w;
      // 起跳点：紧贴这条边的外侧（再受当前这块平台的可行走范围约束）
      const want = side < 0 ? edge - e.w / 2 - NAV.edgeGap : edge + e.w / 2 + NAV.edgeGap;
      const fromX = clamp(want, walkLo, walkHi);
      // 起跳时身体不能还在目标平台的正下方，否则只会顶到平台底面
      if (side < 0 ? fromX + e.w / 2 > edge - NAV.edgeGap : fromX - e.w / 2 < edge + NAV.edgeGap) continue;
      if (!standable(solids, fromX, feet, e.w, e.h)) continue;  // 那个点站不下
      if (!pathClear(solids, e, fromX, top, feet, s, sup)) continue;

      // 落点：从起跳点这一跳能到的范围内，尽量贴近玩家
      let landX = clamp(idealLand, fromX - travel, fromX + travel);
      if (landX < lo - 0.5 || landX > hi + 0.5) continue;       // 这块平台够不到
      if (!standable(solids, landX, top, e.w, e.h)) continue;   // 落点站不下 / 头顶有东西

      // 跳上去必须真的更接近玩家，否则不折腾
      const there = Math.abs(tcx - landX) + 1.3 * Math.abs(tFeet - top);
      if (there > here - 2) continue;
      const cost = there + (rise > riseOne ? 18 : 0)
        + Math.abs(landX - fromX) * 0.25 + Math.abs(fromX - ecx) * NAV.walkCost;
      if (!best || cost < best.cost) {
        best = {
          cost, top, landX, rise, side, solid: s, approachX: fromX,
          needDouble: rise > riseOne,        // 一段跳的顶点不够高，空中得补一跳
        };
      }
    }
  }
  return best;
}

/**
 * 「想怎么走 / 要不要跳」——在 AI 之前调用，AI 用返回的 steerX 修正走位。
 * 真正的起跳由 navAct() 在 AI 之后执行（这样不会覆盖 AI 刚算好的速度方向）。
 */
export function navThink(game, e, target, dt) {
  const out = { steerX: null };
  e.navJump = 0;
  if (e.flying || !target) { e.plan = null; return out; }

  const nav = jumpPower(e);
  if (e.jumpCd > 0) e.jumpCd = Math.max(0, e.jumpCd - dt);
  if (e.blockedT > 0) e.blockedT = Math.max(0, e.blockedT - dt);
  if (e.airChaseT > 0) e.airChaseT = Math.max(0, e.airChaseT - dt);

  const ecx = e.x + e.w / 2;

  if (e.onGround) {
    e.jumps = 0;
    if (e.planAge > 0) e.planAge -= dt;
    else { e.plan = planHop(game, e, target, nav); e.planAge = NAV.planEvery; }

    const plan = e.plan;
    if (plan) {
      // 「到位」= 走到起跳点那一侧、而且身体已经不在平台正下方（否则起跳只会顶到平台底面）
      // 留 edgeGap 的余量：正好贴着边缘起跳的话，上升时会「已经站在柱子里」而躲开阻挡
      const s = plan.solid;
      const clearNow = (ecx + e.w / 2) <= s.x - NAV.edgeGap || (ecx - e.w / 2) >= s.x + s.w + NAV.edgeGap;
      const reached = plan.side < 0
        ? ecx <= plan.approachX + NAV.takeoffTol
        : ecx >= plan.approachX - NAV.takeoffTol;
      out.steerX = plan.approachX;              // 空中会改用 landX，这里先把位置摆正
      if (e.jumpCd <= 0 && e.vy >= -1 && clearNow && reached) e.navJump = 1;
    } else if (e.blockedT > 0 && e.jumpCd <= 0) {
      e.navJump = 2;                            // 没有跳板但被挡住了（卡墙角）→ 干跳一下
    }
    return out;
  }

  // 空中：往落点收，比死追玩家 x 更容易踩上平台边缘
  if (e.plan && e.jumps > 0) out.steerX = e.plan.landX;
  return out;
}

/** 「真的跳」——在 AI 之后、物理之前调用。返回触发的动作（给特效/音效用） */
export function navAct(e) {
  const out = { jumped: false, double: false };
  if (e.flying) return out;
  const nav = jumpPower(e);
  const feet = e.y + e.h;

  // ---- 起跳 ----
  if (e.navJump && e.onGround) {
    const plan = e.navJump === 1 ? e.plan : null;
    if (plan) {
      takeoff(e, nav, plan, NAV.jumpCd);
      out.jumped = true;
    } else if (e.target) {
      // 兜底干跳（卡在墙角之类）：朝玩家方向起跳，能不能上去看运气
      takeoff(e, nav, { landX: e.target.x + e.target.w / 2, top: e.target.y + e.target.h }, NAV.failCd);
      out.jumped = true;
    }
    e.navJump = 0;
  }

  // ---- 空中：预测顶点不够高就补二段跳 ----
  if (e.jumps > 0 && e.jumps < nav.maxJumps && e.jumpCd <= 0) {
    const plan = e.plan;
    const goal = plan ? plan.top : (e.target ? e.target.y + e.target.h : feet);
    if (goal < feet - 4) {                                     // 目标确实在上面才烧二段跳
      const peak = feet - (e.vy < 0 ? (e.vy * e.vy) / (2 * PHYS.gravity) : 0);
      // 必须在顶点附近才交二段跳：二段跳是「替换」竖直速度（和玩家一样），
      // 上升中途就放出去的话，第一跳剩下的那点高度会被白白丢掉，差几十厘米就是上不去。
      const nearApex = e.vy > -NAV.doubleAtVel;
      if (peak > goal + 2 && nearApex) {
        e.vy = -nav.dbl;
        e.jumps += 1;
        e.jumpCd = NAV.jumpCd;
        e.airChaseT = NAV.airChase;
        e.planAge = 0;
        out.jumped = true; out.double = true;
      }
    }
  }
  return out;
}

function takeoff(e, nav, plan, cd) {
  e.vy = -nav.vel;
  e.onGround = false;
  e.jumps = 1;
  e.jumpCd = cd;
  e.blockedT = 0;
  e.planAge = 0;
  e.airChaseT = NAV.airChase;
  // 水平方向：AI 已经在朝落点加速了，这里只兜住「站着原地起跳」的情况
  const dir = Math.sign(plan.landX - (e.x + e.w / 2)) || e.facing || 1;
  const min = e.speed * NAV.airBoost;
  if (Math.abs(e.vx) < min || Math.sign(e.vx) !== dir) e.vx = dir * Math.max(Math.abs(e.vx) * 0.4, min);
}

/** 落地回调：这跳没站上目标平台就罚一下冷却，避免反复原地起跳 */
export function onEnemyLand(e) {
  e.jumps = 0;
  e.airChaseT = 0;
  e.blockedT = 0;     // 落地重新计时，别拿上一跳贴墙的状态当「被挡住」
  const plan = e.plan;
  e.plan = null;
  e.planAge = 0;
  if (plan && Math.abs((e.y + e.h) - plan.top) > 6) e.jumpCd = Math.max(e.jumpCd, NAV.failCd);
}
