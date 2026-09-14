// 权威游戏世界：60Hz 定步长模拟，20Hz 快照广播
import { MODE, PHASE, PLAYER, PVP, TEAM } from '../../../shared/constants.js';
import { getLevel } from '../../../shared/level.js';
import { ENEMY_DEFS } from '../../../shared/enemies.js';
import { WEAPONS, weaponById } from '../../../shared/weapons.js';
import { ITEMS } from '../../../shared/items.js';
import { aabb, centerOf, dist2, circleRect, moveAndCollide } from '../../../shared/physics.js';
import { makeRng } from './rng.js';
import { createEnemy, updateEnemy } from './enemies.js';
import { buildWaveQueue, waveScale } from './waves.js';
import * as P from './player.js';
import * as Shop from './shop.js';

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export class Game {
  constructor(room) {
    this.room = room;
    this.settings = { ...room.settings };
    this.seed = room.seed >>> 0;
    this.rng = makeRng(this.seed);
    this.level = getLevel(this.settings.levelId);
    this.solids = this.level.solids;
    this.players = new Map();
    this.resetState();
  }

  // ---------------------------------------------------------------- 生命周期
  resetState() {
    this.tick = 0;
    this.time = 0;
    this.nextId = 1;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.events = [];
    this.wave = 0;
    this.spawnQueue = [];
    this.waveClock = 0;
    this.phase = PHASE.COUNTDOWN;
    this.phaseTimer = 3.5;
    this.timeLeft = this.settings.timeLimit || 300;
    this.scores = { 0: 0, 1: 0 };
    this.crateTimer = 6;
    this.healTimer = 10;
    this.result = null;
    this.startedAt = Date.now();
  }

  addPlayer(net) {
    const p = P.createPlayer(this, {
      id: net.id, name: net.name, slot: net.slot, team: net.team,
    });
    const want = net.startWeapon || 'pistol';
    P.grantWeapon(p, want);
    if (this.settings.mode !== MODE.PVE) {
      P.grantWeapon(p, want === 'fist' ? 'pistol' : 'fist');
      for (let i = 0; i < 2; i++) {
        const it = this.rng.pick(ITEMS.filter((x) => x.rarity === 'common'));
        P.grantItem(p, it.id);
      }
    }
    p.hp = p.maxHp;
    this.players.set(p.id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  start() {
    this.resetState();
    if (this.settings.mode === MODE.TEAM) {
      // 按加入顺序自动分队
      let i = 0;
      for (const p of this.players.values()) {
        p.team = i % 2;
        i++;
      }
    } else if (this.settings.mode === MODE.FFA) {
      for (const p of this.players.values()) p.team = TEAM.NONE;
    }
    for (const p of this.players.values()) this.placeAtSpawn(p);
    this.phase = PHASE.COUNTDOWN;
    this.phaseTimer = 3.5;
  }

  placeAtSpawn(p) {
    const spawns = this.level.spawns;
    const s = spawns[p.slot % spawns.length];
    p.x = s.x; p.y = s.y;
    p.vx = 0; p.vy = 0;
    p.onGround = false; p.dashT = 0; p.iFrames = 0;
    p.spawnProt = 1.5;
  }

  // ---------------------------------------------------------------- 主循环
  update(dt) {
    this.tick++;
    this.time += dt;
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);

    switch (this.phase) {
      case PHASE.COUNTDOWN:
        if (this.phaseTimer <= 0) {
          if (this.settings.mode === MODE.PVE) this.beginPrep(true);
          else { this.phase = PHASE.PLAYING; }
        }
        break;
      case PHASE.PREP:
        if (this.phaseTimer <= 0 || this.allPlayersReady()) this.beginWave(this.wave + 1);
        break;
      case PHASE.WAVE:
        this.updateWave(dt);
        break;
      case PHASE.PLAYING:
        this.updatePvP(dt);
        break;
      case PHASE.OVER:
      default:
        break;
    }

    // 玩家
    for (const p of this.players.values()) {
      if (p.connected || this.phase !== PHASE.OVER) P.updatePlayer(this, p, dt);
    }

    // 敌人
    if (this.phase === PHASE.WAVE || this.enemies.length) {
      for (const e of this.enemies) updateEnemy(this, e, dt);
      this.separateEnemies();
      if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
    }

    this.updateProjectiles(dt);
    this.updatePickups(dt);

    return this.phase;
  }

  separateEnemies() {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.flying) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.flying) continue;
        if (!aabb(a, b)) continue;
        const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
        const push = dx === 0 ? 0.5 : Math.sign(dx);
        a.x += push * 0.6; b.x -= push * 0.6;
      }
    }
  }

  // ---------------------------------------------------------------- PvE
  beginPrep(first = false) {
    this.phase = PHASE.PREP;
    this.phaseTimer = first ? 12 : this.settings.prepTime || 20;
    // 波间恢复：复活被淘汰的玩家，回复 35% 生命
    for (const p of this.players.values()) {
      if (!p.alive || p.downed) {
        p.alive = true; p.downed = false; p.downTimer = 0; p.reviveProgress = 0;
        p.hp = Math.max(1, Math.round(p.maxHp * 0.6));
        this.placeAtSpawn(p);
      } else {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25);
      }
      Shop.rollShop(this, p);
    }
    this.addEvent({ t: 'prep', w: this.wave + 1 });
    void first;
  }

  allPlayersReady() {
    let any = false;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      any = true;
      if (!p.shop || !p.shop.ready) return false;
    }
    return any;
  }

  beginWave(n) {
    this.wave = n;
    this.spawnQueue = buildWaveQueue(this, n).sort((a, b) => a.t - b.t);
    this.waveClock = 0;
    this.phase = PHASE.WAVE;
    this.phaseTimer = 0;
    for (const p of this.players.values()) p.shop = null;
    this.addEvent({ t: 'wave', n, boss: n % 5 === 0 });
  }

  updateWave(dt) {
    this.waveClock += dt;
    while (this.spawnQueue.length && this.spawnQueue[0].t <= this.waveClock) {
      const s = this.spawnQueue.shift();
      this.spawnFromQueue(s);
    }
    if (!this.spawnQueue.length && this.enemies.length === 0 && this.waveClock > 1) {
      if (this.wave >= (this.settings.totalWaves || 20)) this.endGame(true, 'clear');
      else this.beginPrep();
      return;
    }
    // 全员倒地/阵亡 → 失败
    let anyUp = false;
    for (const p of this.players.values()) {
      if (p.connected && p.alive && !p.downed) { anyUp = true; break; }
    }
    if (!anyUp && this.waveClock > 2) this.endGame(false, 'wipe');
  }

  spawnFromQueue(s) {
    const def = ENEMY_DEFS[s.type];
    const gates = this.level.gates.filter((g) => !!g.fly === !!def.flying);
    const gate = this.rng.pick(gates.length ? gates : this.level.gates);
    const x = Math.max(10, Math.min(this.level.width - def.w - 10, gate.x + this.rng.range(-18, 18)));
    const y = Math.max(-60, gate.y - def.h);
    const e = this.spawnEnemy(s.type, x, y, { elite: s.elite });
    if (e) this.addEvent({ t: 'spawn', x: e.x + e.w / 2, y: e.y + e.h / 2, ty: s.type });
  }

  spawnEnemy(type, x, y, opts = {}) {
    if (this.enemies.length > 140) return null;
    const scale = opts.scale || waveScale(this, Math.max(1, this.wave));
    const e = createEnemy(this, type, x, y, this.wave, { ...opts, scale });
    this.enemies.push(e);
    return e;
  }

  // ---------------------------------------------------------------- PvP
  updatePvP(dt) {
    this.timeLeft -= dt;
    this.crateTimer -= dt;
    this.healTimer -= dt;
    if (this.crateTimer <= 0) {
      this.crateTimer = PVP.crateInterval;
      const spot = this.rng.pick(this.level.crateSpots);
      const w = this.rng.pick(WEAPONS.filter((x) => x.tier <= 3));
      this.spawnPickup('crate', spot.x, spot.y, w.id, { fly: true });
      this.addEvent({ t: 'crate', x: spot.x, y: spot.y });
    }
    if (this.healTimer <= 0) {
      this.healTimer = PVP.healInterval;
      const spot = this.rng.pick(this.level.crateSpots);
      this.spawnPickup('heal', spot.x, spot.y, 35, { fly: true });
    }
    // 计分
    this.scores[0] = 0; this.scores[1] = 0;
    for (const p of this.players.values()) {
      if (p.team === 0) this.scores[0] += p.kills;
      else if (p.team === 1) this.scores[1] += p.kills;
    }
    const limit = this.settings.scoreLimit || 20;
    if (this.settings.mode === MODE.TEAM) {
      if (this.scores[0] >= limit) this.endGame(true, 'team0');
      else if (this.scores[1] >= limit) this.endGame(true, 'team1');
    } else {
      for (const p of this.players.values()) if (p.kills >= limit) this.endGame(true, p.id);
    }
    if (this.timeLeft <= 0) this.endGame(true, 'time');
  }

  // ---------------------------------------------------------------- 战斗
  addEvent(ev) {
    ev.k = this.tick;
    this.events.push(ev);
    if (this.events.length > 400) this.events.shift();
  }

  alivePlayers() {
    const out = [];
    for (const p of this.players.values()) if (p.alive && !p.downed) out.push(p);
    return out;
  }

  nearestAlivePlayer(x, y, maxD = 1e9) {
    let best = null, bd = maxD * maxD;
    for (const p of this.players.values()) {
      if (!p.alive || p.downed) continue;
      const d = dist2(x, y, p.x + p.w / 2, p.y + p.h / 2);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** 自动瞄准：范围内最近的敌对目标 */
  findTarget(from, range, melee = false) {
    const fc = centerOf(from);
    const targets = this.hostileEntitiesOf('player', from);
    let best = null, bd = range * range;
    for (const t of targets) {
      const c = centerOf(t);
      if (melee) {
        const dx = Math.abs(c.x - fc.x);
        if (dx > range) continue;
        if (Math.abs(c.y - fc.y) > 70) continue;
      }
      const d = dist2(fc.x, fc.y, c.x, c.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** 某阵营的投射物可以打到谁 */
  hostileEntitiesOf(faction, owner) {
    if (faction === 'enemy') {
      const out = [];
      for (const p of this.players.values()) if (p.alive && !p.downed) out.push(p);
      return out;
    }
    if (this.settings.mode === MODE.PVE) return this.enemies;
    const out = [];
    for (const p of this.players.values()) {
      if (p === owner || !p.alive || p.downed) continue;
      if (this.settings.mode === MODE.TEAM && p.team === owner.team) continue;
      out.push(p);
    }
    return out;
  }

  dealDamage(source, target, amount, opts = {}) {
    if (target.weapons) return this.damagePlayer(target, amount, source, opts);
    return this.damageEnemy(target, amount, source, opts);
  }

  damagePlayer(p, amount, source, opts = {}) {
    if (!p.alive || p.downed) return false;
    if (p.iFrames > 0 || p.spawnProt > 0) return false;
    if (this.rng() < p.stats.dodge) {
      this.addEvent({ t: 'dodge', id: p.id, x: p.x + p.w / 2, y: p.y });
      p.iFrames = 0.25;
      return false;
    }
    let dmg = Math.max(1, (amount - p.stats.armor) * (1 - p.stats.armorPct));
    p.hp -= dmg;
    p.damageTaken += dmg;
    p.hitFlash = 0.18;
    p.iFrames = opts.contact ? 0.35 : 0;
    if (source && source.damageDealt !== undefined) source.damageDealt += dmg;

    const c = centerOf(p);
    this.addEvent({
      t: 'hit', x: c.x, y: c.y, d: Math.round(dmg), cr: opts.crit ? 1 : 0,
      id: p.id, onPlayer: 1, kb: opts.kb ? 1 : 0,
    });

    if (opts.kb) {
      const dir = Math.sign(c.x - (source ? centerOf(source).x : c.x)) || 1;
      p.vx += dir * opts.kb * 0.55;
      p.vy -= opts.kb * 0.22;
    }
    // 荆棘反伤
    if (opts.contact && source && !source.weapons && p.stats.thorns > 0) {
      this.damageEnemy(source, p.stats.thorns, p, { thorns: true });
    }
    if (p.hp <= 0) {
      p.hp = 0;
      if (this.settings.mode === MODE.PVE) this.downPlayer(p, source);
      else this.killPlayer(p, source);
    }
    return true;
  }

  damageEnemy(e, amount, source, opts = {}) {
    if (!e || e.dead) return false;
    const dmg = Math.max(1, amount);
    e.hp -= dmg;
    e.hitFlash = 0.13;
    if (source && source.damageDealt !== undefined) {
      source.damageDealt += dmg;
      if (source.stats && source.stats.lifesteal > 0 && source.alive && !source.downed) {
        source.hp = Math.min(source.maxHp, source.hp + dmg * source.stats.lifesteal);
      }
    }
    const c = centerOf(e);
    this.addEvent({ t: 'hit', x: c.x, y: c.y, d: Math.round(dmg), cr: opts.crit ? 1 : 0, onPlayer: 0 });
    if (opts.kb && !opts.thorns) {
      const dx = c.x - (source ? centerOf(source).x : c.x - 1);
      const dir = Math.sign(dx) || 1;
      const f = 1 - (e.kbResist || 0);
      e.vx += dir * opts.kb * f * 0.02;
      if (!e.flying) e.vy -= Math.min(320, opts.kb * 0.5) * f * 0.02 * 8;
    }
    if (e.hp <= 0) this.killEnemy(e, source);
    return true;
  }

  killEnemy(e, source) {
    if (e.dead) return;
    e.dead = true;
    const c = centerOf(e);
    this.addEvent({ t: 'die', x: c.x, y: c.y, c: e.def.color, big: e.boss ? 1 : 0, w: e.w });
    const dropXp = e.xp;
    // 掉落
    const n = e.boss ? 8 : 1;
    for (let i = 0; i < n; i++) {
      this.spawnPickup('xp', c.x + this.rng.range(-14, 14), c.y, Math.max(1, Math.round(dropXp / n)));
    }
    if (e.coins > 0) {
      this.spawnPickup('coin', c.x + this.rng.range(-10, 10), c.y, e.coins);
    }
    // 经验：全队共享（合作友好），金币只给击杀者
    for (const p of this.alivePlayers()) P.addXp(this, p, dropXp);
    if (source && source.weapons) {
      source.kills += 1;
      source.coins += Math.round(e.coins * source.stats.coinMul);
      if (source.stats.explode > 0 && this.rng() < source.stats.explode) {
        this.explode(c.x, c.y, e.boss ? 150 : 110, 26 + source.stats.meleeDmg * 2, source, 'player');
      }
    }
  }

  explode(x, y, r, dmg, source, faction, opts = {}) {
    this.addEvent({ t: 'boom', x, y, r, c: opts.color || '#ff922b' });
    const targets = this.hostileEntitiesOf(faction, source);
    for (const t of targets) {
      const c = centerOf(t);
      if (dist2(x, y, c.x, c.y) > r * r) continue;
      this.dealDamage(source, t, dmg, { kb: 260, ...opts });
    }
  }

  raycast(x, y, dx, dy, maxD, cb) {
    const step = 8;
    let px = x, py = y;
    for (let d = 0; d < maxD; d += step) {
      px += dx * step; py += dy * step;
      if (px < 0 || px > this.level.width || py < 0 || py > this.level.height) break;
      let blocked = false;
      for (const s of this.solids) {
        if (px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) { blocked = true; break; }
      }
      if (blocked) break;
      cb(px, py);
    }
    return { x: px, y: py };
  }

  downPlayer(p, source) {
    p.downed = true;
    p.downTimer = PLAYER.downTime;
    p.reviveProgress = 0;
    p.hp = 0;
    p.vx = 0;
    this.addEvent({ t: 'down', id: p.id, x: p.x + p.w / 2, y: p.y + p.h / 2, by: source && !source.weapons ? source.type : '' });
  }

  revivePlayer(p, by) {
    p.downed = false;
    p.downTimer = 0;
    p.reviveProgress = 0;
    p.hp = Math.round(p.maxHp * 0.5);
    p.iFrames = 1.2;
    p.spawnProt = 0.6;
    if (by) by.revived += 1;
    this.addEvent({ t: 'revive', id: p.id, by: by ? by.id : '', x: p.x + p.w / 2, y: p.y + p.h / 2 });
  }

  eliminatePlayer(p) {
    p.alive = false;
    p.downed = false;
    p.respawnTimer = 1e9; // 下一波开始时复活
    p.deaths += 1;
    this.addEvent({ t: 'elim', id: p.id });
  }

  killPlayer(p, source) {
    p.alive = false;
    p.deaths += 1;
    p.respawnTimer = PLAYER.respawnDelay;
    p.hp = 0;
    const killer = source && source.weapons ? source : null;
    if (killer && killer !== p) {
      killer.kills += 1;
      P.addXp(this, killer, 26); // PvP 也能成长：击杀 → 升级 → 三选一
    }
    this.addEvent({
      t: 'kill', id: p.id, by: killer ? killer.id : '', name: p.name,
      byName: killer ? killer.name : '', x: p.x + p.w / 2, y: p.y + p.h / 2,
    });
  }

  respawnPlayer(p) {
    p.alive = true;
    p.hp = Math.round(p.maxHp * 0.7);
    p.respawnTimer = 0;
    p.spawnProt = 1.6;
    p.iFrames = 0;
    this.placeAtSpawn(p);
    this.addEvent({ t: 'respawn', id: p.id });
  }

  // ---------------------------------------------------------------- 投射物
  spawnProjectile(o) {
    const b = {
      id: this.nextId++,
      x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0,
      w: o.w || 0, h: o.h || 0, r: o.r || 5,
      dmg: o.dmg, crit: !!o.crit, life: o.life ?? 2,
      pierce: o.pierce || 0, kb: o.kb || 0,
      homing: o.homing || 0, aoe: o.aoe || 0,
      faction: o.faction, owner: o.owner || null,
      weapon: o.weapon || null, color: o.color || '#fff',
      kind: o.kind || 'bullet', melee: !!o.melee,
      ret: !!o.ret, back: false, t: 0, outT: o.outT || 0.42,
      hitIds: new Set(), dead: false,
    };
    this.projectiles.push(b);
    return b;
  }

  updateProjectiles(dt) {
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dead) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.dead = true;
        if (b.aoe) this.explode(b.x, b.y, b.aoe, b.dmg, b.owner, b.faction);
        continue;
      }

      if (b.melee) {
        const targets = this.hostileEntitiesOf(b.faction, b.owner);
        for (const t of targets) {
          if (b.hitIds.has(t.id) || t.dead) continue;
          if (aabb(b, t)) {
            b.hitIds.add(t.id);
            this.dealDamage(b.owner, t, b.dmg, { crit: b.crit, kb: b.kb, weapon: b.weapon });
          }
        }
        continue;
      }

      // 追踪
      if (b.homing) {
        const targets = this.hostileEntitiesOf(b.faction, b.owner);
        let best = null, bd = 1e9;
        for (const t of targets) {
          if (b.hitIds.has(t.id)) continue;
          const c = centerOf(t);
          const d = dist2(b.x, b.y, c.x, c.y);
          if (d < bd && d < 460 * 460) { bd = d; best = t; }
        }
        if (best) {
          const c = centerOf(best);
          const ang = Math.atan2(c.y - b.y, c.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          let diff = ang - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const na = cur + Math.max(-b.homing * dt, Math.min(b.homing * dt, diff));
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
        }
      }

      // 回旋镖返程
      if (b.ret) {
        b.t += dt;
        if (!b.back && b.t > b.outT) b.back = true;
        if (b.back && b.owner) {
          const c = centerOf(b.owner);
          const ang = Math.atan2(c.y - b.y, c.x - b.x);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(ang) * sp; b.vy = Math.sin(ang) * sp;
          if (dist2(b.x, b.y, c.x, c.y) < 26 * 26) b.dead = true;
        }
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 撞墙
      let hitWall = false;
      for (const s of this.solids) {
        if (circleRect(b.x, b.y, b.r, s)) { hitWall = true; break; }
      }
      if (hitWall) {
        b.dead = true;
        this.addEvent({ t: 'spark', x: b.x, y: b.y, c: b.color });
        if (b.aoe) this.explode(b.x, b.y, b.aoe, b.dmg, b.owner, b.faction);
        continue;
      }

      // 命中实体
      const targets = this.hostileEntitiesOf(b.faction, b.owner);
      for (const t of targets) {
        if (b.hitIds.has(t.id) || t.dead) continue;
        if (!circleRect(b.x, b.y, b.r + 2, t)) continue;
        b.hitIds.add(t.id);
        this.dealDamage(b.owner, t, b.dmg, { crit: b.crit, kb: b.kb, weapon: b.weapon });
        if (b.aoe) {
          this.explode(b.x, b.y, b.aoe, b.dmg * 0.85, b.owner, b.faction);
          b.dead = true;
          break;
        }
        if (b.pierce > 0) b.pierce -= 1;
        else { b.dead = true; break; }
      }
    }
    if (list.some((b) => b.dead)) this.projectiles = list.filter((b) => !b.dead);
  }

  // ---------------------------------------------------------------- 掉落物
  spawnPickup(type, x, y, v, opts = {}) {
    this.pickups.push({
      id: this.nextId++,
      type, x, y, v,
      vx: opts.vx ?? this.rng.range(-90, 90),
      vy: opts.vy ?? this.rng.range(-220, -60),
      w: 14, h: 14,
      fly: !!opts.fly,
      life: type === 'xp' ? 40 : 60,
      dead: false,
    });
  }

  updatePickups(dt) {
    const list = this.pickups;
    for (const k of list) {
      k.life -= dt;
      if (k.life <= 0) { k.dead = true; continue; }
      if (!k.fly && k.settled !== true) {
        k.vy += 1800 * dt;
        const body = { x: k.x - k.w / 2, y: k.y - k.h / 2, w: k.w, h: k.h, vx: k.vx, vy: k.vy };
        const res = moveAndCollide(body, body.vx * dt, body.vy * dt, this.solids);
        k.x = body.x + k.w / 2; k.y = body.y + k.h / 2;
        k.vx = body.vx * (res.hitX ? 0.4 : 0.98); k.vy = body.vy;
        if (res.ground) { k.vy = 0; k.vx *= 0.7; if (Math.abs(k.vx) < 6) k.settled = true; }
        if (res.hitX) k.vx *= -0.4;
      }
      // 磁吸
      let best = null, bd = 1e9;
      for (const p of this.alivePlayers()) {
        const c = centerOf(p);
        const d = dist2(k.x, k.y, c.x, c.y);
        const rad = PLAYER.pickupRadius + p.stats.pickup;
        if (d < rad * rad && d < bd) { bd = d; best = p; }
      }
      if (best) {
        const c = centerOf(best);
        const ang = Math.atan2(c.y - k.y, c.x - k.x);
        const sp = 620;
        k.x += Math.cos(ang) * sp * dt;
        k.y += Math.sin(ang) * sp * dt;
        k.settled = true;
        if (dist2(k.x, k.y, c.x, c.y) < 22 * 22) {
          this.collect(k, best);
          k.dead = true;
        }
      }
    }
    if (list.some((k) => k.dead)) this.pickups = list.filter((k) => !k.dead);
  }

  collect(k, p) {
    switch (k.type) {
      case 'xp':
        P.addXp(this, p, k.v);
        this.addEvent({ t: 'pick', id: p.id, k: 'xp', x: k.x, y: k.y });
        break;
      case 'coin':
        p.coins += Math.max(1, Math.round(k.v * p.stats.coinMul));
        this.addEvent({ t: 'pick', id: p.id, k: 'coin', x: k.x, y: k.y });
        break;
      case 'heal':
        p.hp = Math.min(p.maxHp, p.hp + k.v);
        this.addEvent({ t: 'pick', id: p.id, k: 'heal', x: k.x, y: k.y });
        break;
      case 'crate': {
        const ok = P.grantWeapon(p, k.v);
        if (!ok) p.hp = Math.min(p.maxHp, p.hp + 25);
        this.addEvent({ t: 'pick', id: p.id, k: ok ? 'weapon' : 'heal', v: k.v, x: k.x, y: k.y });
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- 玩家操作 API
  setInput(playerId, input, clientTick) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.input = input;
    if (clientTick !== undefined && clientTick !== null) p.clientTick = clientTick | 0;
  }

  chooseUpgrade(playerId, idx) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false };
    const pick = P.applyChoice(this, p, idx);
    return { ok: !!pick };
  }

  shopBuy(playerId, idx) {
    const p = this.players.get(playerId);
    return p ? Shop.shopBuy(this, p, idx) : { ok: false };
  }

  shopReroll(playerId) {
    const p = this.players.get(playerId);
    return p ? Shop.shopReroll(this, p) : { ok: false };
  }

  setShopReady(playerId, ready) {
    const p = this.players.get(playerId);
    if (p && p.shop) p.shop.ready = !!ready;
  }

  endGame(win, reason) {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    this.result = {
      win: !!win,
      reason,
      wave: this.wave,
      mode: this.settings.mode,
      duration: Math.round((Date.now() - this.startedAt) / 1000),
      scores: { ...this.scores },
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths,
        level: p.level, damage: Math.round(p.damageDealt), taken: Math.round(p.damageTaken),
        coins: Math.round(p.coins), items: p.items, weapons: p.weapons.map((w) => w.id),
      })).sort((a, b) => b.damage - a.damage),
    };
    this.addEvent({ t: 'over', win: win ? 1 : 0 });
  }

  // ---------------------------------------------------------------- 快照
  /** 快照里的公共部分（全场实体 + 本 tick 事件）。events 只能被消费一次，见 snapshotBody */
  snapshot(forId) {
    const snap = this.snapshotBody();
    snap.me = this.snapshotMe(forId);
    return snap;
  }

  /** 丢掉本 tick 的事件（没人可发的时候用，免得事件一直堆着） */
  clearEvents() { this.events.length = 0; }

  snapshotBody() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        i: p.id, x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy),
        f: p.facing, hp: Math.round(p.hp), mx: p.maxHp,
        a: p.alive ? 1 : 0, d: p.downed ? 1 : 0, rp: r2(p.reviveProgress),
        l: p.level, k: p.kills, dd: p.deaths, tm: p.team,
        hf: r2(Math.max(0, p.hitFlash)), sp: r1(Math.max(0, p.spawnProt)),
        dh: p.dashT > 0 ? 1 : 0, cn: p.connected ? 1 : 0,
        w0: p.weapons.length ? p.weapons[0].id : '',
      });
    }
    const enemies = this.enemies.map((e) => ({
      i: e.id, t: e.type, x: r1(e.x), y: r1(e.y), hp: Math.round(e.hp), mx: e.maxHp,
      f: e.facing, el: e.elite ? 1 : 0, hf: r2(Math.max(0, e.hitFlash)), ph: e.phase || 0,
    }));
    const bullets = this.projectiles.map((b) => ({
      i: b.id, x: r1(b.x), y: r1(b.y), vx: r1(b.vx), vy: r1(b.vy),
      r: b.r, w: b.w, h: b.h, c: b.color, k: b.kind, o: b.owner ? b.owner.id : 0,
      fa: b.faction === 'enemy' ? 1 : 0, cr: b.crit ? 1 : 0, wd: b.weapon,
    }));
    const picks = this.pickups.map((k) => ({ i: k.id, t: k.type, x: r1(k.x), y: r1(k.y), v: k.v }));

    const snap = {
      t: this.tick,
      ph: this.phase,
      pt: r1(this.phaseTimer),
      w: this.wave,
      tw: this.settings.totalWaves,
      tl: Math.round(this.timeLeft),
      sc: this.scores,
      ec: this.enemies.length,
      p: players, e: enemies, b: bullets, k: picks,
      ev: this.events,
      me: null,
    };
    this.events = [];        // 事件只能被消费一次：谁拿到 ev 谁就负责把它清掉
    return snap;
  }

  /** 某个玩家独有的那一份（血条/武器/商店/预测用的 clientTick 等） */
  snapshotMe(forId) {
    const me = this.players.get(forId);
    let mine = null;
    if (me) {
      const st = me.stats;
      mine = {
        hp: Math.ceil(me.hp), mx: me.maxHp, xp: Math.round(me.xp), xn: me.xpNeed,
        lv: me.level, coins: Math.round(me.coins), kills: me.kills, deaths: me.deaths,
        dmg: Math.round(me.damageDealt), pl: me.pendingLevels,
        w: me.weapons.map((w) => ({ id: w.id, cd: r2(Math.max(0, w.cd)) })),
        it: me.items,
        ch: me.choices,
        sh: me.shop ? { offers: me.shop.offers, rolls: me.shop.rolls, ready: me.shop.ready } : null,
        rr: Shop.rerollCost(this, me),
        rt: r1(Math.max(0, me.respawnTimer)), dtm: r1(Math.max(0, me.downTimer)),
        ct: me.clientTick || 0,
        ph: [me.onGround ? 1 : 0, me.jumps, r2(me.coyote), r2(me.jumpBuf), r2(me.dashT),
          r2(me.dashCd), r2(me.iFrames), me.prevJump ? 1 : 0, me.prevDash ? 1 : 0],
        st: {
          dmg: r2(st.damageMul), as: r2(st.atkSpeed), crit: r2(st.crit), critMul: r2(st.critMul),
          spd: r2(st.speedMul), armor: Math.round(st.armor * 10) / 10, ap: r2(st.armorPct),
          dodge: r2(st.dodge), ls: r2(st.lifesteal), regen: r2(st.regen),
          melee: st.meleeDmg, ranged: st.rangedDmg, magic: st.magicDmg,
          thorns: st.thorns, pick: st.pickup, proj: st.extraProj, rng: r2(st.rangeMul),
          jm: r2(st.jumpMul), dc: r2(st.dashCdMul),
        },
      };
    }

    return mine;
  }
}
