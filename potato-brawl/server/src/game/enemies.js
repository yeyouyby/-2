// 敌人 AI（纯服务器端；数值表在 shared/enemies.js，客户端渲染也要用）
import { PHYS } from '../../../shared/constants.js';
import { ENEMY_DEFS } from '../../../shared/enemies.js';
import { aabb, centerOf, dist2, moveAndCollide, rectFree } from '../../../shared/physics.js';
import { NAV, navAct, navThink, onEnemyLand } from './nav.js';

export { ENEMY_DEFS };

export function createEnemy(game, type, x, y, wave = 1, opts = {}) {
  const def = ENEMY_DEFS[type];
  const sc = opts.scale || { hp: 1, dmg: 1, speed: 1 };
  const elite = !!opts.elite;
  const e = {
    id: game.nextId++,
    type, def,
    x, y, w: def.w, h: def.h,
    vx: 0, vy: 0,
    facing: 1, onGround: false,
    maxHp: Math.round(def.hp * sc.hp * (elite ? 2.2 : 1)),
    hp: 0,
    dmg: def.dmg * sc.dmg,
    speed: def.speed * sc.speed * (elite ? 1.15 : 1),
    xp: def.xp * (elite ? 3 : 1),
    coins: 0,
    flying: !!def.flying,
    kbResist: def.kbResist || 0,
    elite, boss: !!def.boss,
    ai: def.ai,
    timer: 0, abilityCd: 2 + Math.random(), attackCd: 0,
    hitFlash: 0, stun: 0, dead: false,
    spawnGrace: 0.35,
    phase: 0,
    // 平台追踪用的跳跃状态（见 server/src/game/nav.js）
    jump: def.jump || null,
    jumps: 0, jumpCd: 0, blockedT: 0, planAge: 0, navJump: 0,
    plan: null, steerX: null, airChaseT: 0,
  };
  e.hp = e.maxHp;
  e.coins = Math.max(1, Math.round((type === 'boss' ? 60 : 2 + e.xp * 0.6) * (elite ? 2.5 : 1)));
  return e;
}

/** 敌人每 tick 更新 */
export function updateEnemy(game, e, dt) {
  if (e.hitFlash > 0) e.hitFlash -= dt;
  if (e.spawnGrace > 0) e.spawnGrace -= dt;
  e.timer += dt;
  if (e.attackCd > 0) e.attackCd -= dt;
  if (e.abilityCd > 0) e.abilityCd -= dt;
  if (e.stun > 0) { e.stun -= dt; }

  const target = game.nearestAlivePlayer(e.x + e.w / 2, e.y + e.h / 2, 2600);
  e.target = target;

  // ---- 平台追踪：先决定走位（去起跳点），AI 之后再由 navAct 真正起跳 ----
  // busy = 技能/引信期间不接管移动，免得把冲锋、跳劈的节奏搞乱
  const busy = (e.ai === 'boss' && e.phase !== 0) || (e.ai === 'bomb' && e.phase === 1);
  const chasing = e.stun <= 0 && !e.flying && !!target && !busy;
  e.steerX = chasing ? navThink(game, e, target, dt).steerX : null;
  if (!chasing) { e.plan = null; e.navJump = 0; }

  if (e.stun <= 0) {
    switch (e.ai) {
      case 'hop': aiHop(game, e, target, dt); break;
      case 'rush': aiRush(game, e, target, dt); break;
      case 'fly': aiFly(game, e, target, dt); break;
      case 'shoot': aiShoot(game, e, target, dt); break;
      case 'tank': aiTank(game, e, target, dt); break;
      case 'bomb': aiBomb(game, e, target, dt); break;
      case 'boss': aiBoss(game, e, target, dt); break;
    }
  } else {
    e.vx *= 0.9;
  }

  // ---- 起跳 / 二段跳（放在 AI 之后，才不会覆盖 AI 刚算好的水平方向）----
  if (chasing) {
    const act = navAct(e);
    if (act.jumped) {
      game.addEvent({
        t: act.double ? 'edouble' : 'jump',
        x: e.x + e.w / 2, y: e.y + e.h, f: e.facing,
      });
    }
  }

  // 物理
  if (!e.flying) {
    e.vy += PHYS.gravity * dt;
    if (e.vy > PHYS.maxFall) e.vy = PHYS.maxFall;
  }
  const wasGround = e.onGround;
  const preVx = e.vx;              // 碰撞解算会改 vx，保留动量得用撞之前的值
  e.onGround = false;
  // ledge：正在往上爬的那块平台，上升时按「柱子」解算，避免斜插进平台底面被判定成天花板
  const ledge = !e.flying && e.plan ? e.plan.solid : null;
  const res = moveAndCollide(e, e.vx * dt, e.vy * dt, game.solids, ledge);
  if (!e.flying) {
    e.onGround = res.ground;
    if (res.ground) e.jumps = 0;      // 落地就重置段跳数（不依赖导航是否执行）
    if (res.ground && e.vy > 0) e.vy = 0;
    if (res.ground && !wasGround) onEnemyLand(e);
  }
  // 差一点点就够到平台边缘 → 一把扒上去（卡 10 厘米比表演一段失败的抛物线好看）。
  // 光抬高度不够：身体还整只在平台外侧的话，抬完照样是空的，所以要连水平位置一起挪到台面上。
  if (res.climb && !res.ground && !e.flying && e.plan && e.vy < 260) {
    const s = e.plan.solid;
    const gap = (e.y + e.h) - e.plan.top;
    if (gap > 0 && gap <= NAV.ledgeGrab) {
      const fromLeft = (e.x + e.w / 2) < s.x + s.w / 2;
      const nx = fromLeft ? s.x + 2 : s.x + s.w - e.w - 2;
      const stand = { x: nx, y: e.plan.top - e.h - 1, w: e.w, h: e.h + 1 };
      if (nx > 0 && nx + e.w < game.level.width && rectFree(game.solids, stand)) {
        e.x = nx;
        e.y = e.plan.top - e.h;
        e.vy = 0;
        e.onGround = true;
        onEnemyLand(e);
      }
    }
  }
  if (res.hitX) {
    // 记录「被挡住」，导航会据此强制起跳翻过去。moveAndCollide 里已经把 vx 清零了，
    // 所以空中要拿碰撞前的速度来保留动量，不然贴着墙上不去、落地又在同一处反复蹭。
    if (!e.flying) e.blockedT = NAV.blockedHold;
    e.vx = e.onGround ? 0 : preVx * 0.6;
  }

  // 世界边界兜底：被击退/挤到墙外、掉出场地的怪要拉回来，否则会一直往下掉
  const WW = game.level.width, WH = game.level.height;
  if (e.x < 0) { e.x = 0; if (e.vx < 0) e.vx = 0; }
  if (e.x + e.w > WW) { e.x = WW - e.w; if (e.vx > 0) e.vx = 0; }
  if (e.y > WH + 240) { e.y = (game.solids[0] ? game.solids[0].y : WH) - e.h - 2; e.vy = 0; e.plan = null; e.jumpCd = 0.3; }

  // 接触伤害
  if (target && e.attackCd <= 0) {
    for (const p of game.alivePlayers()) {
      if (!aabb(e, p)) continue;
      if (game.damagePlayer(p, e.dmg, e, { contact: true })) {
        e.attackCd = e.boss ? 1.0 : 0.75;
        // 撞击后反弹一点，避免糊在玩家脸上
        const dir = Math.sign(p.x + p.w / 2 - (e.x + e.w / 2)) || 1;
        e.vx = -dir * 180;
        if (!e.flying) e.vy = -220;
      }
    }
  }
}

function stepToward(e, tx, speed, dt, accel = 1500) {
  // 导航给出的走位目标优先（绕到起跳点 / 空中收拢到落点）
  if (e.steerX != null) tx = e.steerX;
  const dir = Math.sign(tx - (e.x + e.w / 2)) || 1;
  e.facing = dir;
  e.vx += dir * accel * dt;
  // 追平台的那一跳允许稍微超一点地面移速，否则弧线永远差几十厘米够不着边缘
  const max = e.airChaseT > 0 ? speed * NAV.airChaseMul : speed;
  if (Math.abs(e.vx) > max) e.vx = dir * max;
}

function aiHop(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  stepToward(e, target.x + target.w / 2, e.speed, dt);
  // 史莱姆的招牌连蹦：只在没有「跳平台计划」要执行时插空来一下，
  // 免得和导航抢起跳时机（导航跳完会把 onGround 置空，这里自然不会重复触发）
  if (e.timer > 1.4 && e.onGround && e.jumps === 0 && e.jumpCd <= 0 && !e.plan) {
    e.timer = 0;
    e.vy = -560;
    e.jumps = 1;
    e.jumpCd = 0.1;
    e.vx *= 1.25;
  }
}

function aiRush(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  const tc = centerOf(target), ec = centerOf(e);
  const d2 = dist2(ec.x, ec.y, tc.x, tc.y);
  if (d2 < 260 * 260 && e.abilityCd <= 0) {
    // 冲刺：导航想跳上平台时，把冲刺的瞄准点改成起跳点/落点，别一头撞在平台侧面上
    const aimX = e.steerX != null ? e.steerX : tc.x;
    const aimY = e.plan && e.plan.top < tc.y ? e.plan.top + 8 : tc.y;
    e.abilityCd = 1.6;
    const dx = aimX - ec.x, dy = aimY - ec.y;
    const len = Math.hypot(dx, dy) || 1;
    e.vx = (dx / len) * 620;
    e.vy = (dy / len) * 420 - 120;
    e.jumps = Math.max(1, e.jumps);   // 这段冲程当成「已经用掉一跳」，二段跳留给空中修正
    e.stun = 0.08;
    game.addEvent({ t: 'rush', x: ec.x, y: ec.y });
    return;
  }
  stepToward(e, tc.x, e.speed, dt, 2200);
}

function aiFly(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; e.vy = Math.sin(e.timer * 3) * 40; return; }
  const tc = centerOf(target), ec = centerOf(e);
  const dx = tc.x - ec.x, dy = (tc.y - 40 + Math.sin(e.timer * 2.2) * 45) - ec.y;
  const len = Math.hypot(dx, dy) || 1;
  e.vx = (dx / len) * e.speed;
  e.vy = (dy / len) * e.speed;
  e.facing = dx >= 0 ? 1 : -1;
}

function aiShoot(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  const tc = centerOf(target), ec = centerOf(e);
  const dx = tc.x - ec.x;
  const adx = Math.abs(dx);
  if (adx > 340) stepToward(e, tc.x, e.speed, dt);
  else if (adx < 220) stepToward(e, tc.x - Math.sign(dx) * 400, e.speed, dt);
  else e.vx *= 0.85;
  e.facing = dx >= 0 ? 1 : -1;
  if (e.attackCd <= 0 && adx < 700) {
    e.attackCd = 1.7;
    const len = Math.hypot(tc.x - ec.x, tc.y - ec.y) || 1;
    game.spawnProjectile({
      owner: e, faction: 'enemy',
      x: ec.x, y: ec.y,
      vx: ((tc.x - ec.x) / len) * 520,
      vy: ((tc.y - ec.y) / len) * 520,
      r: 7, dmg: e.dmg, life: 2.2, pierce: 0,
      color: '#ffe066', kind: 'bullet',
    });
    game.addEvent({ t: 'shot', x: ec.x, y: ec.y, c: '#ffe066' });
  }
}

function aiTank(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  stepToward(e, target.x + target.w / 2, e.speed, dt, 900);
}

function aiBomb(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  const ec = centerOf(e), tc = centerOf(target);
  if (e.phase === 0) {
    stepToward(e, tc.x, e.speed, dt, 2000);
    if (dist2(ec.x, ec.y, tc.x, tc.y) < 70 * 70) { e.phase = 1; e.timer = 0; }
  } else {
    // 引信
    e.vx *= 0.8;
    if (e.timer > 0.85) {
      game.explode(ec.x, ec.y, 96, e.dmg, e, 'enemy');
      game.addEvent({ t: 'boom', x: ec.x, y: ec.y, r: 96 });
      game.killEnemy(e, null, { silent: true });
    }
  }
}

function aiBoss(game, e, target, dt) {
  if (!target) { e.vx *= 0.9; return; }
  const tc = centerOf(target), ec = centerOf(e);
  const enrage = e.hp / e.maxHp < 0.4;
  const dx = tc.x - ec.x;
  e.facing = dx >= 0 ? 1 : -1;

  if (e.phase === 1) {
    // 冲锋中
    e.vx = e.facing * 760;
    e.timer += 0;
    if (e.timer > 1.1 || Math.abs(e.vx) < 50) {
      e.phase = 0; e.timer = 0; e.abilityCd = enrage ? 2.0 : 3.2;
      e.vx *= 0.3;
    }
    return;
  }
  if (e.phase === 2) {
    // 跳劈
    e.vx *= 0.92;
    if (e.onGround && e.timer > 0.35) {
      e.phase = 0; e.timer = 0; e.abilityCd = enrage ? 2.2 : 3.4;
      game.explode(ec.x, ec.y + 20, 150, e.dmg * 1.2, e, 'enemy', { shockwave: true });
      game.addEvent({ t: 'boom', x: ec.x, y: ec.y + 20, r: 150 });
    }
    return;
  }

  stepToward(e, tc.x, e.speed * (enrage ? 1.35 : 1), dt, 900);

  if (e.abilityCd <= 0) {
    const roll = game.rng();
    if (roll < 0.4) {
      // 冲锋
      e.phase = 1; e.timer = 0;
      game.addEvent({ t: 'bossroar', x: ec.x, y: ec.y });
    } else if (roll < 0.75) {
      // 跳劈
      e.phase = 2; e.timer = 0;
      e.vy = -820;
      e.vx = Math.sign(dx) * 320;
    } else {
      // 召唤小弟
      e.abilityCd = enrage ? 3.0 : 4.5;
      const n = enrage ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const sx = ec.x + game.rng.range(-160, 160);
        const sy = ec.y - 40;
        const minion = game.spawnEnemy(i % 2 === 0 ? 'slime' : 'rusher', sx, sy);
        if (minion) game.addEvent({ t: 'spawn', x: sx, y: sy });
      }
      game.addEvent({ t: 'bossroar', x: ec.x, y: ec.y });
    }
  }
}
