// 共享物理：AABB + 重力 + 平台碰撞。服务器与客户端使用同一份代码，
// 这样客户端才能做「预测 + 服务器回滚校正」而不产生抖动。
import { IN, PHYS } from './constants.js';

export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectsOverlap(a, b) {
  return aabb(a, b);
}

export function circleRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

function approach(v, target, delta) {
  if (v < target) return Math.min(v + delta, target);
  if (v > target) return Math.max(v - delta, target);
  return target;
}

/**
 * 轴分离式移动 + 碰撞解算。body: {x,y,w,h}（x,y 为左上角）
 *
 * ledge（可选）：正在「往上爬」的那块平台。上升过程中如果脚还没超过平台顶面，
 * 就把这块平台临时向下加厚成一根柱子再解算 X —— 否则角色会斜着插进平台底面，
 * Y 轴解算把这一撞判成「顶到头」（vy 归零），二段跳白白浪费，永远爬不上平台。
 * 玩家不需要这个（人是自己操作的，会贴着边缘卡一下再翻上去），跳平台上来的怪需要。
 */
const CLIMB_EXT = 400;

export function moveAndCollide(b, dx, dy, solids, ledge) {
  const res = { hitX: false, hitY: false, ground: false, ceil: false, climb: false };
  const climb = ledge && dy < 0 && b.y + b.h > ledge.y + 0.5
    ? { x: ledge.x, y: ledge.y, w: ledge.w, h: ledge.h + CLIMB_EXT }
    : null;
  b.x += dx;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabb(b, s)) continue;
    if (dx > 0) b.x = s.x - b.w;
    else if (dx < 0) b.x = s.x + s.w;
    b.vx = 0;
    res.hitX = true;
  }
  if (climb) {
    // 只拦「这一 tick 从侧面挤进柱子」的情况（上一 tick 还整只在这块平台的左/右侧外面）。
    // 已经在平台正下方时不做修正，否则会被瞬移式推出去。
    const px = b.x - dx;
    if (dx > 0 && px + b.w <= climb.x + 0.01 && b.x + b.w > climb.x) {
      b.x = climb.x - b.w; res.climb = true;          // 不清 vx：贴着平台边缘往上蹭，翻过去那一下还要靠这个速度
    } else if (dx < 0 && px >= climb.x + climb.w - 0.01 && b.x < climb.x + climb.w) {
      b.x = climb.x + climb.w; res.climb = true;
    }
  }
  b.y += dy;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabb(b, s)) continue;
    if (dy > 0) { b.y = s.y - b.h; res.ground = true; }
    else if (dy < 0) { b.y = s.y + s.h; res.ceil = true; }
    b.vy = 0;
    res.hitY = true;
  }
  return res;
}

/**
 * 驱动一个角色（玩家）走一个 tick。
 * actor 需要字段：x,y,w,h,vx,vy,facing,onGround,coyote,jumpBuf,jumps,dashCd,dashT,dashDir,iFrames,prevJump,prevDash
 * 返回本 tick 触发的动作标记（用于音效/特效）。
 */
export function stepActor(a, input, dt, solids, o = {}) {
  const speedMul = o.speedMul ?? 1;
  const maxSpeed = (o.speed ?? 250) * speedMul;
  const accel = o.accel ?? PHYS.accel;
  const airAccel = o.airAccel ?? PHYS.airAccel;
  const friction = o.friction ?? PHYS.friction;
  const airFriction = o.airFriction ?? PHYS.airFriction;
  const gravity = (o.gravity ?? PHYS.gravity) * (o.gravityScale ?? 1);
  const maxFall = o.maxFall ?? PHYS.maxFall;
  const maxJumps = o.maxJumps ?? PHYS.maxJumps;

  const dir = ((input & IN.RIGHT) ? 1 : 0) - ((input & IN.LEFT) ? 1 : 0);
  const out = { jumped: false, double: false, dashed: false, landed: false };

  // ---- 计时器 ----
  if (a.iFrames > 0) a.iFrames -= dt;
  if (a.dashCd > 0) a.dashCd -= dt;
  if (a.onGround) { a.coyote = o.coyote ?? PHYS.coyote; a.jumps = 0; }
  else if (a.coyote > 0) a.coyote -= dt;

  // ---- 冲刺 ----
  const dashHeld = (input & IN.DASH) !== 0;
  if (dashHeld && !a.prevDash && a.dashCd <= 0 && a.dashT <= 0 && o.canDash !== false) {
    a.dashT = o.dashTime ?? PHYS.dashTime;
    a.dashDir = dir !== 0 ? dir : (a.facing || 1);
    a.facing = a.dashDir;
    a.dashCd = o.dashCooldown ?? PHYS.dashCooldown;
    a.iFrames = Math.max(a.iFrames || 0, o.dashIFrames ?? PHYS.dashIFrames);
    out.dashed = true;
  }
  a.prevDash = dashHeld;

  if (a.dashT > 0) {
    a.dashT -= dt;
    a.vx = a.dashDir * (o.dashSpeed ?? PHYS.dashSpeed);
    a.vy = 0;
    if (a.dashT <= 0) a.vx *= 0.4;
  } else {
    // ---- 水平 ----
    if (dir !== 0) {
      a.facing = dir;
      const ac = a.onGround ? accel : airAccel;
      a.vx += dir * ac * dt;
      if (Math.sign(a.vx) === dir && Math.abs(a.vx) > maxSpeed) {
        // 击退等外力造成的超速：平滑衰减而不是硬截断
        a.vx = approach(a.vx, dir * maxSpeed, (a.onGround ? friction : airFriction) * dt);
      }
    } else {
      a.vx = approach(a.vx, 0, (a.onGround ? friction : airFriction) * dt);
    }
    // ---- 重力 ----
    a.vy += gravity * dt;
    if (a.vy > maxFall) a.vy = maxFall;
  }

  // ---- 跳跃（带 coyote time + 输入缓冲） ----
  const jumpHeld = (input & IN.JUMP) !== 0;
  if (jumpHeld && !a.prevJump) a.jumpBuf = o.jumpBuffer ?? PHYS.jumpBuffer;
  else if (a.jumpBuf > 0) a.jumpBuf -= dt;
  a.prevJump = jumpHeld;

  if (a.jumpBuf > 0) {
    if (a.onGround || a.coyote > 0) {
      a.vy = -(o.jumpVel ?? PHYS.jumpVel);
      a.onGround = false; a.coyote = 0; a.jumpBuf = 0; a.jumps = 1;
      out.jumped = true;
    } else if (a.jumps < maxJumps) {
      a.vy = -(o.doubleJumpVel ?? PHYS.doubleJumpVel);
      a.jumps += 1; a.jumpBuf = 0;
      out.jumped = true; out.double = true;
    }
  }

  // ---- 积分 ----
  const wasGround = a.onGround;
  a.onGround = false;
  const res = moveAndCollide(a, a.vx * dt, a.vy * dt, solids);
  a.onGround = res.ground;
  if (res.ground && !wasGround) out.landed = true;
  if (res.ground) a.jumps = 0;

  // ---- 世界边界（兜底，防止穿墙） ----
  const W = o.worldW ?? 1600, H = o.worldH ?? 900;
  if (a.x < 0) { a.x = 0; a.vx = 0; }
  if (a.x + a.w > W) { a.x = W - a.w; a.vx = 0; }
  if (a.y > H + 200) { a.y = H - a.h; a.vy = 0; }

  return out;
}

// ---------------------------------------------------------------- 平台导航小工具
// 敌人 AI 用它判断「能不能跳上这块平台」「站在某个点会不会卡头」，
// 客户端预览/测试也可以复用，所以放在 shared 里。

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 某个矩形是否不与任何实心块重叠（站立净空检查） */
export function rectFree(solids, r) {
  for (let i = 0; i < solids.length; i++) if (aabb(r, solids[i])) return false;
  return true;
}

/** 以初速度 v 起跳能上升的最大高度（忽略空气阻力，v²/2g） */
export function apexRise(v, gravity = PHYS.gravity) {
  return (v * v) / (2 * gravity);
}

/**
 * 找到实体脚下踩着的实心块（用于判断「我们是否站在同一块平台上」）。
 * 返回该实心块，或 null（例如站在地板上时返回地板）。
 */
export function supportUnder(solids, e, tol = 2) {
  const feet = e.y + e.h;
  let best = null;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (s.y < feet - tol || s.y > feet + 40) continue;   // 必须在脚下附近
    if (e.x + e.w <= s.x + 1 || e.x >= s.x + s.w - 1) continue; // 水平没重叠
    if (!best || s.y < best.y) best = s;                 // 取最高的一块
  }
  return best;
}

/** 命中矩形：近战挥击范围 */
export function facingRect(actor, reach, height) {
  const w = reach, h = height ?? actor.h + 6;
  const x = actor.facing >= 0 ? actor.x + actor.w - 4 : actor.x - w + 4;
  return { x, y: actor.y + (actor.h - h) / 2, w, h };
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export function centerOf(e) {
  return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
}
