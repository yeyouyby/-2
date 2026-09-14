// 客户端游戏状态：快照插值 + 本地预测/服务器校正 + 特效
import { TICK_DT, PHASE, MODE, PLAYER, PLAYER_COLORS } from '/shared/constants.js';
import { getLevel } from '/shared/level.js';
import { stepActor } from '/shared/physics.js';
import { ENEMY_DEFS } from '/shared/enemies.js';
import { weaponById } from '/shared/weapons.js';
import { Renderer } from './render.js';

const INTERP_MS = 90;
const MAX_PARTICLES = 260;

export class GameClient {
  constructor(net, audio, ui) {
    this.net = net;
    this.audio = audio;
    this.ui = ui;
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new Renderer(this);
    this.level = getLevel('farm');
    this.mode = MODE.PVE;
    this.myId = null;
    this.active = false;
    this.tick = 0;
    this.acc = 0;
    this.history = [];
    this.particles = [];
    this.beams = [];
    this.portals = [];
    this.view = { players: [], enemies: [], bullets: [], pickups: [] };
    this.prev = null;
    this.next = null;
    this.roster = new Map();
    this.shake = 0;
    this.hurtFlash = 0;
    this.phase = PHASE.LOBBY;
    this.pred = null;
    this.stats = null;
    this.lastHp = 0;
    this.input = null;
  }

  setRoster(state) {
    this.roster = new Map(state.players.map((p) => [p.id, p]));
  }

  colorOf(id, slot) {
    const r = this.roster.get(id);
    return PLAYER_COLORS[(r ? r.slot : slot || 0) % PLAYER_COLORS.length];
  }

  nameOf(id, fallback = '???') {
    const r = this.roster.get(id);
    return r ? r.name : fallback;
  }

  // ------------------------------------------------------------ 生命周期
  start(msg) {
    this.level = getLevel(msg.levelId);
    this.mode = msg.mode;
    this.settings = msg.settings;
    this.myId = this.net.id;
    this.active = true;
    this.tick = 0;
    this.acc = 0;
    this.history = [];
    this.particles = [];
    this.beams = [];
    this.portals = [];
    this.prev = null;
    this.next = null;
    this.pred = this.freshPred();
    if (this.input) this.input.enabled = true;
  }

  stop() {
    this.active = false;
    if (this.input) this.input.enabled = false;
    this.view = { players: [], enemies: [], bullets: [], pickups: [] };
  }

  freshPred(x = 0, y = 0) {
    return {
      x, y, w: PLAYER.w, h: PLAYER.h, vx: 0, vy: 0, facing: 1,
      onGround: false, coyote: 0, jumpBuf: 0, jumps: 0,
      dashCd: 0, dashT: 0, dashDir: 1, iFrames: 0, prevJump: false, prevDash: false,
      alive: true, downed: false,
    };
  }

  // ------------------------------------------------------------ 快照
  onSnapshot(s) {
    if (!this.active) return;
    const now = performance.now();
    this.prev = this.next || { ...s, recv: now - 50 };
    this.next = { ...s, recv: now };
    this.phase = s.ph;
    this.wave = s.w;
    this.phaseTimer = s.pt;
    this.timeLeft = s.tl;
    this.scores = s.sc;

    const me = s.me;
    const sp = me ? s.p.find((p) => p.i === this.myId) : null;
    if (me) {
      this.stats = me.st;
      if (sp) {
        this.applyServer(sp, me);
        const from = me.ct || 0;
        let replayed = 0;
        for (const h of this.history) {
          if (h.q > from) { this.stepPred(h.i); replayed++; }
        }
        if (from) this.history = this.history.filter((h) => h.q > from);
        void replayed;
      }
      if (this.lastHp && me.hp < this.lastHp) {
        this.hurtFlash = Math.min(0.45, 0.18 + (this.lastHp - me.hp) / 120);
        this.audio.hurt();
      }
      this.lastHp = me.hp;
    }

    if (s.ev && s.ev.length) for (const e of s.ev) this.handleEvent(e);
  }

  applyServer(sp, me) {
    const p = this.pred || (this.pred = this.freshPred());
    p.x = sp.x; p.y = sp.y; p.vx = sp.vx; p.vy = sp.vy; p.facing = sp.f;
    const ph = me.ph || [];
    p.onGround = !!ph[0]; p.jumps = ph[1] || 0; p.coyote = ph[2] || 0; p.jumpBuf = ph[3] || 0;
    p.dashT = ph[4] || 0; p.dashCd = ph[5] || 0; p.iFrames = ph[6] || 0;
    p.prevJump = !!ph[7]; p.prevDash = !!ph[8];
    p.alive = !!sp.a; p.downed = !!sp.d;
    p.w = PLAYER.w; p.h = PLAYER.h;
  }

  stepPred(mask) {
    const p = this.pred;
    if (!p || !p.alive || p.downed) return;
    const st = this.stats || {};
    stepActor(p, mask, TICK_DT, this.level.solids, {
      speed: PLAYER.baseSpeed,
      speedMul: st.spd ?? 1,
      jumpVel: 690 * (1 + ((st.jm ?? 1) - 1) * 0.6),
      dashCooldown: 1.1 * (st.dc ?? 1),
      worldW: this.level.width,
      worldH: this.level.height,
    });
  }

  // ------------------------------------------------------------ 事件 → 表现
  handleEvent(e) {
    switch (e.t) {
      case 'hit': {
        this.sparks(e.x, e.y, e.cr ? 10 : 5, e.cr ? '#ffd43b' : '#fff3bf');
        if (e.d > 0) this.dmgText(e.x, e.y, e.d, e.cr);
        if (e.onPlayer) this.audio.hit(!!e.cr);
        break;
      }
      case 'die': {
        this.audio.kill();
        const n = e.big ? 34 : 12;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 60 + Math.random() * (e.big ? 320 : 150);
          this.particles.push({
            type: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
            g: 700, life: 0.5 + Math.random() * 0.5, max: 1, size: 3 + Math.random() * 5, color: e.c || '#ff8787',
          });
        }
        if (e.big) { this.shake = 24; this.audio.boom(); }
        break;
      }
      case 'boom': {
        this.shake = Math.max(this.shake, 14);
        this.audio.boom();
        this.particles.push({ type: 'ring', x: e.x, y: e.y, r: e.r, life: 0.45, max: 0.45, size: 8, color: '#ff922b' });
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * Math.PI * 2;
          this.particles.push({
            type: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220,
            g: 400, life: 0.5, max: 0.5, size: 6, color: i % 3 ? '#ff922b' : '#ffe066',
          });
        }
        break;
      }
      case 'shot': {
        this.audio.shoot(e.w || '');
        this.particles.push({ type: 'spark', x: e.x, y: e.y, vx: 0, vy: 0, g: 0, life: 0.08, max: 0.08, size: 9, color: e.c || '#fff' });
        break;
      }
      case 'swing':
        this.audio.swing();
        break;
      case 'beam':
        this.beams.push({ x: e.x, y: e.y, x2: e.x2, y2: e.y2, color: e.c || '#ff4ddb', life: 0.16, max: 0.16 });
        this.audio.shoot('laser');
        break;
      case 'spark':
        this.sparks(e.x, e.y, 3, e.c || '#fff');
        break;
      case 'jump':
        if (e.id === this.myId) this.audio.jump();
        this.sparks(e.x, e.y, 3, '#e8d5b7');
        break;
      case 'dash':
        if (e.id === this.myId) this.audio.dash();
        for (let i = 0; i < 6; i++) {
          this.particles.push({
            type: 'spark', x: e.x, y: e.y, vx: -i * 20, vy: 0, g: 0,
            life: 0.22, max: 0.22, size: 6 - i * 0.5, color: '#a5d8ff',
          });
        }
        break;
      case 'spawn':
        this.portals.push({ x: e.x, y: e.y, life: 0.7, max: 0.7 });
        break;
      case 'lvlup':
        if (e.id === this.myId) { this.audio.levelup(); this.ui.banner('升级！', 1.2); }
        break;
      case 'pick':
        if (e.k === 'coin') this.audio.coin();
        break;
      case 'wave':
        this.audio.wave();
        this.ui.banner(e.boss ? `第 ${e.n} 波 —— BOSS 来袭！` : `第 ${e.n} 波`, 2.2);
        break;
      case 'down':
        this.audio.down();
        this.ui.banner('队友倒地了！去救人！', 2);
        break;
      case 'revive':
        this.audio.revive();
        this.ui.banner('救援成功！', 1.4);
        break;
      case 'kill':
        this.ui.killFeed(e.byName || '环境', e.name, e.by && this.roster.get(e.by) ? '#ffd43b' : '#ccc');
        break;
      case 'respawn':
        if (e.id === this.myId) this.ui.banner('重新参战！', 1);
        break;
      case 'crate':
        this.portals.push({ x: e.x, y: e.y, life: 0.5, max: 0.5 });
        break;
      case 'prep':
        this.ui.banner(`第 ${e.w} 波即将开始 · 备战阶段`, 2);
        break;
      default: break;
    }
  }

  dmgText(x, y, d, crit) {
    if (this.particles.length > MAX_PARTICLES) return;
    this.particles.push({
      type: 'text', x: x + (Math.random() - 0.5) * 14, y: y - 12,
      vx: (Math.random() - 0.5) * 30, vy: -70, g: 90,
      life: crit ? 1.0 : 0.7, max: crit ? 1.0 : 0.7,
      size: crit ? 22 : 15, text: (crit ? '' : '') + d + (crit ? '!' : ''),
      color: crit ? '#ffd43b' : '#ffffff',
    });
  }

  sparks(x, y, n, color) {
    if (this.particles.length > MAX_PARTICLES) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      this.particles.push({
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 500,
        life: 0.22 + Math.random() * 0.2, max: 0.42, size: 2 + Math.random() * 3, color,
      });
    }
  }

  // ------------------------------------------------------------ 帧循环
  frame(dt) {
    if (!this.active) return;
    // 固定步长：输入采样 + 本地预测
    this.acc += dt;
    let guard = 0;
    while (this.acc >= TICK_DT && guard++ < 5) {
      this.acc -= TICK_DT;
      this.tick++;
      if (this.input && this.input.enabled) {
        const mask = this.input.sample();
        this.history.push({ q: this.tick, i: mask });
        if (this.history.length > 240) this.history.shift();
        this.net.send({ t: 'input', i: mask, q: this.tick });
        this.stepPred(mask);
      }
    }

    // 特效推进
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += (p.g || 0) * dt;
    }
    if (this.particles.length) this.particles = this.particles.filter((p) => p.life > 0);
    for (const b of this.beams) b.life -= dt;
    if (this.beams.length) this.beams = this.beams.filter((b) => b.life > 0);
    for (const p of this.portals) p.life -= dt;
    if (this.portals.length) this.portals = this.portals.filter((p) => p.life > 0);
    this.shake *= Math.pow(0.001, dt);
    if (this.shake < 0.4) this.shake = 0;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);

    this.buildView();
    this.renderer.draw(dt);
  }

  /** 根据 prev/next 快照插值出渲染用的实体列表 */
  buildView() {
    const b = this.next;
    if (!b) return;
    const a = this.prev;
    const now = performance.now();
    const rt = now - INTERP_MS;
    let k = 1;
    if (a && b.recv > a.recv) k = Math.max(0, Math.min(1.3, (rt - a.recv) / (b.recv - a.recv)));
    const lerp = (x1, x2) => (x1 === undefined ? x2 : x1 + (x2 - x1) * k);

    const amap = new Map();
    if (a) {
      for (const p of a.p) amap.set('p' + p.i, p);
      for (const e of a.e) amap.set('e' + e.i, e);
      for (const x of a.b) amap.set('b' + x.i, x);
      for (const x of a.k) amap.set('k' + x.i, x);
    }

    const players = [];
    for (const sp of b.p) {
      const ap = amap.get('p' + sp.i);
      const isMe = sp.i === this.myId;
      let x = ap ? lerp(ap.x, sp.x) : sp.x;
      let y = ap ? lerp(ap.y, sp.y) : sp.y;
      let vx = sp.vx, vy = sp.vy, facing = sp.f, onGround = null;
      if (isMe && this.pred && this.pred.alive && !this.pred.downed) {
        x = this.pred.x; y = this.pred.y; vx = this.pred.vx; vy = this.pred.vy;
        facing = this.pred.facing; onGround = this.pred.onGround;
      }
      players.push({
        id: sp.i, isMe, x, y, vx, vy, facing, onGround,
        w: PLAYER.w, h: PLAYER.h,
        hp: sp.hp, maxHp: sp.mx, alive: !!sp.a, downed: !!sp.d,
        reviveProgress: sp.rp || 0, level: sp.l, kills: sp.k, team: sp.tm,
        hf: sp.hf, sp: sp.sp || 0, dashing: !!sp.dh,
        name: this.nameOf(sp.i, '玩家'), color: this.colorOf(sp.i),
        weapon: sp.w0 || (b.me && isMe ? (b.me.w[0] && b.me.w[0].id) : null) || 'pistol',
      });
    }

    const enemies = b.e.map((se) => {
      const ae = amap.get('e' + se.i);
      const def = ENEMY_DEFS[se.t] || ENEMY_DEFS.slime;
      return {
        i: se.i, t: se.t,
        x: ae ? lerp(ae.x, se.x) : se.x,
        y: ae ? lerp(ae.y, se.y) : se.y,
        w: def.w, h: def.h, hp: se.hp, mx: se.mx, f: se.f, el: se.el, hf: se.hf, ph: se.ph,
      };
    });

    const bullets = b.b.map((sb) => {
      const ab = amap.get('b' + sb.i);
      const def = sb.wd ? weaponById(sb.wd) : null;
      let shape = 'bullet';
      if (sb.wd === 'rocket') shape = 'rocket';
      else if (sb.wd === 'staff' || sb.wd === 'laser') shape = 'orb';
      else if (sb.wd === 'boomerang') shape = 'boomerang';
      return {
        i: sb.i,
        x: ab ? lerp(ab.x, sb.x) : sb.x,
        y: ab ? lerp(ab.y, sb.y) : sb.y,
        vx: sb.vx, vy: sb.vy, r: sb.r, w: sb.w, h: sb.h,
        color: sb.c || (def ? def.color : '#fff'), shape, kind: sb.k,
        faction: sb.fa ? 'enemy' : 'player',
      };
    });

    const pickups = b.k.map((sk) => {
      const ak = amap.get('k' + sk.i);
      return {
        i: sk.i, t: sk.t,
        x: ak ? lerp(ak.x, sk.x) : sk.x,
        y: ak ? lerp(ak.y, sk.y) : sk.y,
        v: sk.v,
      };
    });

    this.view = { players, enemies, bullets, pickups };
  }
}
