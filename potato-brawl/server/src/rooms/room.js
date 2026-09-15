// 房间：大厅状态、成员管理、消息路由、快照广播
import { DEFAULT_SETTINGS, MODE, PHASE, MAX_PLAYERS, TICK_DT, SNAPSHOT_EVERY } from '../../../shared/constants.js';
import { LEVELS } from '../../../shared/level.js';
import { Game } from '../game/game.js';
import { applyCheckpoint, checkpointOf, saveSummary } from '../data/saves.js';

// 所有会被拼进浏览器 innerHTML 的文本（聊天、房间名…）都先过一遍这里：
// 尖括号/引号/与号一律剥掉，控制字符去掉，再截断长度。客户端那边也做了转义（双保险）。
export function cleanText(input, max = 160) {
  return String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/<[^>]*>/g, '')          // 整段标签直接删（<b>x</b> → x），否则只剩尖括号会糊成一坨
    .replace(/[<>&"'`]/g, '')         // 落单的尖括号/引号也剥掉：这些都是要拼进 innerHTML 的
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const MODE_SET = new Set(Object.values(MODE));
const LEVEL_SET = new Set(Object.keys(LEVELS));
// 设置项全部来自房主的网络消息，必须限死范围：difficulty 会直接乘进刷怪预算（waves.js），
// 给个 1e9 就能把服务器卡在构造敌人那一帧；levelId 更狠，'__proto__' 会取到 Object.prototype。
const NUM_RANGE = {
  maxPlayers: [1, MAX_PLAYERS, true],
  totalWaves: [1, 60, true],
  difficulty: [0.2, 3, false],
  prepTime: [3, 120, true],
  scoreLimit: [1, 200, true],
  timeLimit: [30, 3600, true],
  teamSize: [1, MAX_PLAYERS, true],
  endlessBonusEvery: [0, 40, true],        // 0 = 关掉无尽奖励
};
const BOOL_KEYS = ['autoSave'];

/** 只认 DEFAULT_SETTINGS 里的键（顺带挡掉 __proto__ 之类），非法值一律丢弃 */
export function cleanSettings(input, current) {
  const out = { ...(current || DEFAULT_SETTINGS) };
  const src = input && typeof input === 'object' ? input : {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = src[k];
    if (k === 'mode') { if (MODE_SET.has(v)) out.mode = v; continue; }
    if (k === 'levelId') {
      if (typeof v === 'string' && LEVEL_SET.has(v)) out.levelId = v;
      continue;
    }
    if (BOOL_KEYS.includes(k)) { out[k] = !!v; continue; }
    const range = NUM_RANGE[k];
    if (!range) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(range[1], Math.max(range[0], n));
    out[k] = range[2] ? Math.round(clamped) : clamped;
  }
  return out;
}

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
    this.lastCheckpointWave = -1;   // 自动存档去重：同一波只写一次
  }

  // ------------------------------------------------------------ 成员
  addPlayer(ws, { id, name, token, user = '' }) {
    const np = {
      id, name, ws, token,
      user: String(user || '').slice(0, 20),   // 登录账号；存档/战绩按它归属
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
    const wasHost = !!np.host;
    if (drop) {
      this.players.delete(id);
      // 明确退出去的人要从模拟里摘掉：只标 connected=false 的话，他会继续被 AI 当靶子、
      // 继续吃伤害，还会在结算里挂个空名字
      if (this.game) this.game.removePlayer(id);
    } else {
      np.connected = false;
      const gp = this.game ? this.game.players.get(id) : null;
      if (gp) gp.connected = false;
    }
    // 交房主：只在真的被移除时转交，并且要把原房主的标记清掉，
    // 否则他 60 秒内重连就会变成两个房主（都能改设置/开局）
    if (drop && wasHost) {
      np.host = false;
      const next = [...this.players.values()].find((p) => p.connected && p.id !== id);
      if (next) next.host = true;
    }
    if (this.players.size === 0) this.manager.removeRoom(this.code);
  }

  /**
   * 断线重连：网络成员和对局里的玩家都要标回 connected。
   * 只标网络侧的话，合作模式的「全员倒地」判定（game.js 里要 p.connected）会把刚回来的人漏掉，
   * 单人局可能在重连成功的下一秒被判团灭。
   */
  reconnect(id, ws) {
    const np = this.players.get(id);
    if (!np) return false;
    np.ws = ws;
    np.connected = true;
    const gp = this.game ? this.game.players.get(id) : null;
    if (gp) gp.connected = true;
    return true;
  }

  // ------------------------------------------------------------ 存档点（明文 JSON，见 server/src/data/store.js）
  get store() { return this.manager.store || null; }
  get accounts() { return this.manager.accounts || null; }
  autoSaveOn() { return this.settings.autoSave !== false; }
  /** 房间里已登录账号的名单：存档归属与读取权限都按它来 */
  memberUsers() { return [...this.players.values()].map((p) => p.user).filter(Boolean); }

  /**
   * 写一个检查点。只在波次边界做（商店开着、怪清完、人站在地上），
   * 这样读档 = 开一局新的对局再把成长灌回去，不用去碰预测/回滚那一层。
   */
  checkpoint() {
    if (!this.store) return { error: '服务器没开存储' };
    if (!this.game) return { error: '还没开局' };
    if (this.game.phase === PHASE.OVER) return { error: '这局已经结束了，存不了' };
    const users = this.memberUsers();
    if (!users.length) return { error: '没有人登录，存档不知道归谁（先登录再存）' };
    const g = this.game;
    const run = checkpointOf(g, {
      label: `第 ${g.wave + 1} 波前`,
      owners: users,
      code: this.code,
    });
    run.by = (this.host && this.host.user) || users[0];
    const saved = this.store.putSave(run);
    for (const u of users) this.accounts && this.accounts.attachSave(u, saved.id);
    this.lastCheckpointWave = g.wave;
    return { ok: true, save: saved };
  }

  /** 本房间能看到的存档：自己名下的 + 房间成员名下的（可以跨房间码恢复） */
  listSavesFor(np) {
    if (!this.store) return [];
    const roomUsers = this.memberUsers();
    const me = np && np.user;
    return this.store.listSaves((r) => {
      const owners = (r.owners || []).concat(r.by ? [r.by] : []);
      if (me && owners.includes(me)) return true;
      return owners.some((o) => roomUsers.includes(o));
    }).map(saveSummary);
  }

  /** 从检查点继续：用存档里的种子/设置重开一局，然后把 build、金币、波次接上 */
  loadRun(id, byNp) {
    if (!this.store) return { error: '服务器没开存储' };
    const run = this.store.getSave(id);
    if (!run) return { error: '存档不存在（可能已被更新覆盖，或超出保存条数上限）' };
    const owners = (run.owners || []).concat(run.by ? [run.by] : []);
    const mine = [byNp && byNp.user, ...this.memberUsers()].filter(Boolean);
    if (owners.length && !owners.some((o) => mine.includes(o))) return { error: '这不是你的存档' };
    if (this.game && this.game.phase !== PHASE.OVER && !byNp.host) return { error: '只有房主能读档' };

    this.settings = cleanSettings({ ...(run.settings || {}), autoSave: this.settings.autoSave }, this.settings);
    for (const p of this.players.values()) p.ready = true;
    this.game = null;
    this.start({ seed: Number(run.seed) >>> 0 });
    const res = applyCheckpoint(this.game, run);
    this.lastCheckpointWave = res.wave;      // 别让自动存档马上又把刚读进来的这份盖掉
    this.broadcast({ t: 'loaded', id: run.id, wave: res.wave + 1, restored: res.restored });
    this.chat_('系统', `从检查点继续：第 ${res.wave + 1} 波（${run.mode === MODE.ENDLESS ? '无尽' : 'PvE'}），恢复了 ${res.restored} 人的 build`, true);
    if (res.warnings.length) this.chat_('系统', '读档提示：' + res.warnings.join('；'), true);
    return { ok: true, wave: res.wave + 1, restored: res.restored, warnings: res.warnings };
  }

  forgetSave(id, np) {
    if (!this.store) return { error: '服务器没开存储' };
    const run = this.store.getSave(id);
    if (!run) return { error: '存档不存在' };
    const owners = (run.owners || []).concat(run.by ? [run.by] : []);
    const allowed = (np && np.host) || (np && np.user && owners.includes(np.user));
    if (!allowed) return { error: '只能删自己的存档' };
    this.store.deleteSave(id);
    if (this.accounts) for (const o of owners) this.accounts.detachSave(o, id);
    return { ok: true };
  }

  /** 一局结束：战绩写进账号，顺手在房间里播报新纪录 */
  recordResults(result) {
    const acc = this.accounts;
    if (!acc || !result) return;
    for (const rp of result.players || []) {
      const user = this.players.get(rp.id) && this.players.get(rp.id).user;
      if (!user) continue;
      const before = acc.get(user);
      const wasEndless = (before && before.stats.endless.bestWave) || 0;
      const wasAny = (before && before.stats.bestWave) || 0;
      acc.recordMatch(user, {
        mode: result.mode, wave: result.wave, win: result.win,
        kills: rp.kills, deaths: rp.deaths, damage: rp.damage, time: result.duration,
      });
      const now = acc.get(user);
      if (!now) continue;
      if (result.mode === MODE.ENDLESS && now.stats.endless.bestWave > wasEndless) {
        this.chat_('系统', `🏆 ${rp.name} 的无尽纪录刷新：第 ${now.stats.endless.bestWave} 波 / ${now.stats.endless.bestTime}s`, true);
      } else if (now.stats.bestWave > wasAny) {
        this.chat_('系统', `🏆 ${rp.name} 的最高波数刷新：第 ${now.stats.bestWave} 波`, true);
      }
    }
    this.store && this.store.mark('accounts');
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
        startWeapon: p.startWeapon, user: p.user || '',
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

  start(opts = {}) {
    this.lastCheckpointWave = -1;
    this.seed = opts.seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : (opts.seed >>> 0);
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
    this.lastCheckpointWave = -1;
    for (const p of this.players.values()) p.ready = false;
    this.broadcast({ t: 'lobby' });
    this.broadcastRoom();
  }

  tick(dt) {
    if (!this.game) return;
    const g = this.game;
    g.update(dt);
    this.tickCount++;

    // 检查点：只在「进商店」那一刻写（同一波只写一次）
    if (g.phase === PHASE.PREP && this.lastCheckpointWave !== g.wave) {
      this.lastCheckpointWave = g.wave;
      if (this.autoSaveOn()) {
        const r = this.checkpoint();
        if (r.ok) this.broadcast({ t: 'saved', id: r.save.id, wave: g.wave + 1, auto: true });
        else if (r.error && this.players.size && g.wave > 0) this.chat_('系统', '自动存档没写成：' + r.error, true);
      }
    }

    if (g.phase === PHASE.OVER) {
      if (this.overTimer === 0) {
        this.overTimer = 90; // 90 秒后自动回到大厅
        this.broadcast({ t: 'over', result: g.result });
        this.recordResults(g.result);
      }
      this.overTimer -= dt;
      if (this.overTimer <= 0) { this.backToLobby(); return; }
    }

    if (this.tickCount % SNAPSHOT_EVERY === 0) {
      // snapshot() 会把 this.events 清空，所以每人调一次的话只有第一个人拿得到事件
      // （跳/命/死亡这些特效就只发给一个人）。公共部分算一次，逐人只补自己的那份。
      const live = [...this.players.values()].filter((p) => p.ws && p.ws.readyState === 1);
      if (!live.length) { g.clearEvents(); return; }
      const body = g.snapshotBody();
      for (const p of live) {
        const snap = { ...body, t: 'snap', me: g.snapshotMe(p.id) };
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
        this.settings = cleanSettings(msg.settings, this.settings);
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
        const text = cleanText(msg.text, 160);
        if (text) this.chat_(np.name, text);
        break;
      }

      case 'saves':
        send(np.ws, { t: 'saveList', saves: this.listSavesFor(np) });
        break;

      case 'saveNow': {
        if (!np.host) return send(np.ws, { t: 'err', msg: '只有房主能手动存档' });
        const r = this.checkpoint();
        if (r.error) return send(np.ws, { t: 'err', msg: r.error });
        this.chat_('系统', `已存到检查点：第 ${this.game.wave + 1} 波前（${r.save.id}）`, true);
        send(np.ws, { t: 'saved', id: r.save.id, wave: this.game.wave + 1 });
        send(np.ws, { t: 'saveList', saves: this.listSavesFor(np) });
        break;
      }

      case 'saveLoad': {
        if (!np.host) return send(np.ws, { t: 'err', msg: '只有房主能读档' });
        const r = this.loadRun(msg.id, np);
        if (r.error) return send(np.ws, { t: 'err', msg: r.error });
        send(np.ws, { t: 'saveList', saves: this.listSavesFor(np) });
        break;
      }

      case 'saveDelete': {
        const r = this.forgetSave(msg.id, np);
        if (r.error) return send(np.ws, { t: 'err', msg: r.error });
        send(np.ws, { t: 'saveList', saves: this.listSavesFor(np) });
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
