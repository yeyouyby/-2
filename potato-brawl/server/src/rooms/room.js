// 房间：大厅状态、成员管理、消息路由、快照广播
import { DEFAULT_SETTINGS, MODE, PHASE, MAX_PLAYERS, TICK_DT, SNAPSHOT_EVERY } from '../../../shared/constants.js';
import { Game } from '../game/game.js';

const CODE_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

export class Room {
  constructor(manager, code, opts = {}) {
    this.manager = manager;
    this.code = code;
    this.name = opts.name || `${opts.hostName || '土豆'}的房间`;
    this.players = new Map(); // id -> netPlayer
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
    this.game = null;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.chat = [];
    this.tickCount = 0;
    this.overTimer = 0;
    this.createdAt = Date.now();
    this.slotSeq = 0;
  }

  // ------------------------------------------------------------ 成员
  addPlayer(ws, { id, name, token }) {
    const np = {
      id, name, ws, token,
      slot: this.slotSeq++,
      team: 0, ready: false,
      startWeapon: 'pistol',
      connected: true,
      host: this.players.size === 0,
      lastInputAt: 0,
    };
    this.players.set(id, np);
    if (this.game) {
      // 中途加入：直接进入对局（旁观会等下一波/重生）
      const gp = this.game.addPlayer(np);
      if (gp) this.game.placeAtSpawn(gp);
    }
    return np;
  }

  removePlayer(id, { drop = true } = {}) {
    const np = this.players.get(id);
    if (!np) return;
    if (drop) this.players.delete(id);
    else np.connected = false;
    if (this.game) this.game.players.get(id) && (this.game.players.get(id).connected = false);
    // 转交房主
    if (np.host) {
      const next = [...this.players.values()].find((p) => p.connected && p.id !== id);
      if (next) next.host = true;
    }
    if (this.players.size === 0) this.manager.removeRoom(this.code);
  }

  get host() {
    return [...this.players.values()].find((p) => p.host) || [...this.players.values()][0];
  }

  empty() {
    return this.players.size === 0;
  }

  // ------------------------------------------------------------ 广播
  broadcast(obj, exceptId = null) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId || !p.ws || p.ws.readyState !== 1) continue;
      try { p.ws.send(s); } catch { /* ignore */ }
    }
  }

  broadcastRoom() {
    this.broadcast({ t: 'room', room: this.state() });
  }

  state() {
    return {
      code: this.code,
      name: this.name,
      host: this.host ? this.host.id : null,
      phase: this.game ? 'game' : 'lobby',
      settings: this.settings,
      maxPlayers: this.settings.maxPlayers,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, team: p.team,
        ready: p.ready, host: p.host, connected: p.connected,
        startWeapon: p.startWeapon,
      })),
      game: this.game ? {
        phase: this.game.phase, wave: this.game.wave, total: this.game.settings.totalWaves,
        timeLeft: Math.round(this.game.timeLeft),
      } : null,
    };
  }

  summary() {
    return {
      code: this.code, name: this.name,
      players: this.players.size, max: this.settings.maxPlayers,
      mode: this.settings.mode, level: this.settings.levelId,
      phase: this.game ? 'game' : 'lobby',
      wave: this.game ? this.game.wave : 0,
    };
  }

  chat_(name, text, sys = false) {
    this.chat.push({ name, text, sys, at: Date.now() });
    if (this.chat.length > 60) this.chat.shift();
    this.broadcast({ t: 'chat', name, text, sys });
  }

  // ------------------------------------------------------------ 流程
  canStart() {
    if (this.game) return '游戏已开始';
    if (this.players.size < 1) return '至少需要 1 名玩家';
    if (this.settings.mode === MODE.TEAM && this.players.size < 2) return '团队战至少需要 2 人';
    const notReady = [...this.players.values()].filter((p) => !p.ready && p.connected);
    if (notReady.length) return '还有玩家未准备';
    return null;
  }

  start() {
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.game = new Game(this);
    for (const np of this.players.values()) {
      np.ready = false;
      this.game.addPlayer(np);
    }
    this.game.start();
    this.overTimer = 0;
    this.broadcast({
      t: 'start',
      mode: this.settings.mode,
      levelId: this.settings.levelId,
      seed: this.seed,
      settings: this.game.settings,
      myIds: Object.fromEntries([...this.players.values()].map((p) => [p.id, p.id])),
    });
    this.broadcastRoom();
  }

  backToLobby() {
    this.game = null;
    for (const p of this.players.values()) p.ready = false;
    this.broadcast({ t: 'lobby' });
    this.broadcastRoom();
  }

  tick(dt) {
    if (!this.game) return;
    const g = this.game;
    g.update(dt);
    this.tickCount++;

    if (g.phase === PHASE.OVER) {
      if (this.overTimer === 0) {
        this.overTimer = 90; // 90 秒后自动回到大厅
        this.broadcast({ t: 'over', result: g.result });
      }
      this.overTimer -= dt;
      if (this.overTimer <= 0) { this.backToLobby(); return; }
    }

    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      for (const p of this.players.values()) {
        if (!p.ws || p.ws.readyState !== 1) continue;
        const snap = g.snapshot(p.id);
        snap.t = 'snap';
        try { p.ws.send(JSON.stringify(snap)); } catch { /* ignore */ }
      }
    }
  }

  // ------------------------------------------------------------ 消息
  handle(np, msg) {
    switch (msg.t) {
      case 'ready':
        np.ready = !!msg.v;
        this.broadcastRoom();
        break;

      case 'settings': {
        if (!np.host) return send(np.ws, { t: 'err', msg: '只有房主可以修改设置' });
        if (this.game) return send(np.ws, { t: 'err', msg: '对局中无法修改设置' });
        const s = msg.settings || {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (s[k] !== undefined) this.settings[k] = s[k];
        }
        this.settings.maxPlayers = Math.max(1, Math.min(MAX_PLAYERS, this.settings.maxPlayers | 0));
        this.broadcastRoom();
        this.manager.broadcastRoomList();
        break;
      }

      case 'loadout':
        np.startWeapon = String(msg.weapon || 'pistol').slice(0, 20);
        this.broadcastRoom();
        break;

      case 'setTeam': {
        if (this.game) return;
        if (this.settings.mode !== MODE.TEAM) return;
        const team = msg.team === 1 ? 1 : 0;
        const counts = [0, 0];
        for (const q of this.players.values()) counts[q.team === 1 ? 1 : 0]++;
        const cap = Math.ceil(this.players.size / 2);
        if (counts[team] >= cap && np.team !== team) {
          return send(np.ws, { t: 'err', msg: '该队伍人数已满，请先让对面的玩家换过来' });
        }
        np.team = team;
        this.broadcastRoom();
        break;
      }

      case 'start': {
        if (!np.host) return send(np.ws, { t: 'err', msg: '只有房主可以开始游戏' });
        const err = this.canStart();
        if (err) return send(np.ws, { t: 'err', msg: err });
        this.start();
        break;
      }

      case 'back':
        if (this.game && this.game.phase === PHASE.OVER) this.backToLobby();
        break;

      case 'input': {
        if (!this.game) return;
        const g = this.game;
        const gp = g.players.get(np.id);
        if (!gp) return;
        g.setInput(np.id, msg.i | 0, msg.q | 0);
        break;
      }

      case 'pick': {
        if (!this.game) return;
        const r = this.game.chooseUpgrade(np.id, msg.idx | 0);
        if (!r.ok) send(np.ws, { t: 'err', msg: '无法选择' });
        break;
      }

      case 'buy': {
        if (!this.game) return;
        const r = this.game.shopBuy(np.id, msg.idx | 0);
        if (!r.ok) send(np.ws, { t: 'err', msg: r.msg || '购买失败' });
        break;
      }

      case 'reroll': {
        if (!this.game) return;
        const r = this.game.shopReroll(np.id);
        if (!r.ok) send(np.ws, { t: 'err', msg: r.msg || '刷新失败' });
        break;
      }

      case 'shopReady': {
        if (!this.game) return;
        this.game.setShopReady(np.id, !!msg.v);
        break;
      }

      case 'chat': {
        const text = String(msg.text || '').slice(0, 160);
        if (text) this.chat_(np.name, text);
        break;
      }

      case 'ping':
        send(np.ws, { t: 'pong', ts: msg.ts, st: this.game ? this.game.tick : 0 });
        break;

      default:
        break;
    }
    return undefined;
  }
}

export { TICK_DT };
