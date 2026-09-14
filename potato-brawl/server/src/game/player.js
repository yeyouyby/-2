// 玩家实体：属性计算、输入驱动、自动开火、升级
import { PLAYER, IN, TEAM, PLAYER_COLORS } from '../../../shared/constants.js';
import { computeStats, rollUpgrades, itemById } from '../../../shared/items.js';
import { weaponById } from '../../../shared/weapons.js';
import { centerOf, dist2, circleRect, aabb, stepActor } from '../../../shared/physics.js';

export { PLAYER_COLORS };

export function xpForLevel(level) {
  return Math.round(9 + level * 5 + Math.pow(level, 1.62));
}

export function recomputeStats(p) {
  const before = p.stats ? p.stats.maxHpAdd : 0;
  p.stats = computeStats(p.items);
  const maxHp = Math.max(1, Math.round(PLAYER.baseHp + p.stats.maxHpAdd));
  const delta = maxHp - p.maxHp;
  p.maxHp = maxHp;
  if (delta > 0) p.hp = Math.min(maxHp, p.hp + delta);
  p.hp = Math.min(p.hp, p.maxHp);
  void before;
}

export function createPlayer(game, { id, name, slot, team = TEAM.NONE }) {
  const spawn = game.level.spawns[slot % game.level.spawns.length];
  const p = {
    id, name, slot, team,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    x: spawn.x, y: spawn.y, w: PLAYER.w, h: PLAYER.h,
    vx: 0, vy: 0, facing: 1, onGround: false,
    coyote: 0, jumpBuf: 0, jumps: 0, dashCd: 0, dashT: 0, dashDir: 1, iFrames: 0,
    prevJump: false, prevDash: false,
    input: 0,
    hp: PLAYER.baseHp, maxHp: PLAYER.baseHp,
    alive: true, downed: false, downTimer: 0, reviveProgress: 0,
    respawnTimer: 0, spawnProt: 1.5,
    level: 1, xp: 0, xpNeed: xpForLevel(1),
    coins: 0, kills: 0, deaths: 0, damageDealt: 0, damageTaken: 0, revived: 0,
    weapons: [], items: {},
    pendingLevels: 0, choices: null,
    shop: null,
    hitFlash: 0, attackTick: 0, connected: true,
    stats: computeStats({}),
  };
  recomputeStats(p);
  p.hp = p.maxHp;
  return p;
}

export function grantWeapon(p, weaponId) {
  const def = weaponById(weaponId);
  if (!def) return false;
  if (p.weapons.some((w) => w.id === weaponId)) return false;
  if (p.weapons.length >= 6) return false;
  p.weapons.push({ id: weaponId, cd: 0 });
  return true;
}

export function grantItem(p, itemId) {
  const it = itemById(itemId);
  if (!it) return false;
  p.items[itemId] = (p.items[itemId] || 0) + 1;
  recomputeStats(p);
  return true;
}

export function addXp(game, p, amount) {
  p.xp += amount * p.stats.xpMul;
  let leveled = false;
  while (p.xp >= p.xpNeed) {
    p.xp -= p.xpNeed;
    p.level += 1;
    p.pendingLevels += 1;
    p.xpNeed = xpForLevel(p.level);
    leveled = true;
  }
  if (leveled) {
    game.addEvent({ t: 'lvlup', id: p.id, x: p.x + p.w / 2, y: p.y });
    refreshChoices(game, p);
  }
}

export function refreshChoices(game, p) {
  if (p.pendingLevels > 0 && !p.choices) {
    p.choices = rollUpgrades(game.rng, {
      items: p.items, weapons: p.weapons.map((w) => w.id), count: 3,
      weaponChance: 0.24, allowWeapon: p.weapons.length < 6,
    });
  }
}

export function applyChoice(game, p, idx) {
  if (!p.choices) return null;
  const pick = p.choices[idx];
  if (!pick) return null;
  p.choices = null;
  p.pendingLevels = Math.max(0, p.pendingLevels - 1);
  if (pick.kind === 'item') grantItem(p, pick.id);
  else grantWeapon(p, pick.id);
  game.addEvent({ t: 'pick', id: p.id, k: pick.kind, v: pick.id });
  refreshChoices(game, p);
  return pick;
}

/** 玩家每 tick 更新（移动 + 自动开火 + 状态计时） */
export function updatePlayer(game, p, dt) {
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.spawnProt > 0) p.spawnProt -= dt;

  if (!p.alive) {
    p.respawnTimer -= dt;
    if (p.respawnTimer <= 0) game.respawnPlayer(p);
    return;
  }

  // 倒地（仅 PvE）
  if (p.downed) {
    p.downTimer -= dt;
    if (p.downTimer <= 0) { game.eliminatePlayer(p); return; }
    let reviving = false;
    for (const o of game.alivePlayers()) {
      if (o === p || o.downed) continue;
      if (dist2(centerOf(o).x, centerOf(o).y, centerOf(p).x, centerOf(p).y) < PLAYER.reviveRange ** 2) {
        p.reviveProgress += dt / PLAYER.reviveTime;
        reviving = true;
        if (p.reviveProgress >= 1) {
          game.revivePlayer(p, o);
          return;
        }
      }
    }
    if (!reviving) p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.35);
    return;
  }

  // 生命回复
  if (p.stats.regen > 0 && p.hp < p.maxHp) {
    p.hp = Math.min(p.maxHp, p.hp + p.stats.regen * dt);
  }

  // 移动（与客户端共享同一份 stepActor）
  const flags = stepActor(p, p.input, dt, game.solids, {
    speed: PLAYER.baseSpeed,
    speedMul: p.stats.speedMul,
    jumpVel: 690 * (1 + (p.stats.jumpMul - 1) * 0.6),
    dashCooldown: 1.1 * p.stats.dashCdMul,
    worldW: game.level.width, worldH: game.level.height,
  });
  if (flags.jumped) game.addEvent({ t: 'jump', id: p.id, x: p.x + p.w / 2, y: p.y + p.h });
  if (flags.dashed) game.addEvent({ t: 'dash', id: p.id, x: p.x + p.w / 2, y: p.y + p.h / 2 });

  // 自动开火
  fireWeapons(game, p, dt);
}

function weaponDamage(def, stats) {
  const flat = def.dmgType === 'melee' ? stats.meleeDmg : def.dmgType === 'ranged' ? stats.rangedDmg : stats.magicDmg;
  return (def.dmg + flat) * stats.damageMul;
}

function fireWeapons(game, p, dt) {
  const st = p.stats;
  for (const w of p.weapons) {
    const def = weaponById(w.id);
    if (!def) continue;
    if (w.cd > 0) { w.cd -= dt; continue; }
    const range = (def.type === 'melee' ? (def.reach || 60) + 26 : (def.range || 500)) * st.rangeMul;
    const target = game.findTarget(p, range, def.type === 'melee');
    if (!target) { w.cd = Math.min(w.cd, 0.05); continue; }
    w.cd = def.cd / Math.max(0.05, st.atkSpeed);
    fireOnce(game, p, def, target);
  }
}

function fireOnce(game, p, def, target) {
  const st = p.stats;
  const tc = centerOf(target);
  const pc = { x: p.x + p.w / 2, y: p.y + p.h * 0.42 };
  const crit = game.rng() < st.crit;
  let dmg = weaponDamage(def, st) * (crit ? st.critMul : 1);

  if (def.type === 'melee') {
    const reach = (def.reach || 60) * st.rangeMul;
    const rect = {
      x: p.facing >= 0 ? p.x + p.w * 0.5 : p.x + p.w * 0.5 - reach,
      y: p.y - 6, w: reach, h: p.h + 12,
    };
    game.spawnProjectile({
      owner: p, faction: 'player', weapon: def.id, melee: true,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      vx: 0, vy: 0, dmg, crit, life: 0.14, pierce: 99,
      kb: def.kb || 120, color: def.color, kind: 'swing',
    });
    game.addEvent({ t: 'swing', id: p.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, f: p.facing, c: def.color });
    return;
  }

  // 瞄准（带轻微预判）
  let dx = tc.x - pc.x, dy = tc.y - pc.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;

  if (def.hitscan) {
    // 激光：瞬发射线，贯穿
    const maxD = (def.range || 800) * st.rangeMul;
    const hit = [];
    const end = game.raycast(pc.x, pc.y, dx, dy, maxD, (px, py) => {
      for (const e of game.hostileEntitiesOf('player', p)) {
        if (hit.includes(e) || e.dead) continue;
        if (circleRect(px, py, 8, e)) hit.push(e);
      }
    });
    game.addEvent({ t: 'beam', x: pc.x, y: pc.y, x2: end.x, y2: end.y, c: def.color });
    for (const e of hit) game.dealDamage(p, e, dmg, { crit, kb: 0, weapon: def.id });
    if (!hit.length) game.addEvent({ t: 'shot', x: pc.x, y: pc.y, c: def.color, s: 0.4 });
    return;
  }

  const pellets = (def.pellets || 1) + (def.type === 'ranged' ? st.extraProj : 0);
  const spread = def.spread || 0;
  for (let i = 0; i < pellets; i++) {
    let ang = Math.atan2(dy, dx);
    if (spread) ang += (game.rng() - 0.5) * spread + (pellets > 1 && !def.pellets ? (i - (pellets - 1) / 2) * 0.06 : 0);
    const sp = (def.speed || 800) * st.projSpeedMul;
    game.spawnProjectile({
      owner: p, faction: 'player', weapon: def.id,
      x: pc.x + dx * 12, y: pc.y + dy * 12,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      r: def.size || 5, dmg: dmg / (def.pellets ? 1 : Math.max(1, pellets * 0.85)),
      crit, life: ((def.range || 600) * st.rangeMul) / sp + 0.35,
      pierce: def.pierce || 0, kb: def.kb || 80, homing: def.homing || 0,
      aoe: def.aoe || 0, color: def.color, kind: 'bullet',
      ret: !!def.ret,
    });
  }
  game.addEvent({ t: 'shot', x: pc.x, y: pc.y, c: def.color, s: 1, w: def.id });
}
