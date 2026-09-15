// 明文 JSON 数据存储：账号 + 检查点存档。
//
// 为什么明文（本次需求定的）：这服务器只跑在局域网 / 自己的机器上，数据要能随手
// cat、手改、整个目录拷走备份，所以账号、密码、存档、战绩全是可读 JSON，不加密不哈希。
// ⚠️ 要放公网的话至少把 pass 换成 hash（见 accounts.js 顶部），并收紧 data/ 目录权限。
//
// 落盘：内存改完先标脏，300ms 后合并写一次；写临时文件 + rename，避免留下半个文件。
// 退出前必须 close()（里面会 flush + 释放 .lock）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_VERSION = 1;
export const MAX_ACCOUNTS = 5000;
export const MAX_SAVES = 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 默认数据目录：<项目根>/data */
export function defaultDataDir() { return path.resolve(__dirname, '../../../data'); }

const EMPTY_ACCOUNTS = () => ({ v: DATA_VERSION, updatedAt: 0, accounts: {} });
const EMPTY_SAVES = () => ({ v: DATA_VERSION, updatedAt: 0, seq: 1, saves: {} });

/**
 * JS 的对象 key 里有一批是特殊的：`map[k]=v` 对它们是「改原型 / 加方法」而不是「新增一条记录」，
 * 而 JSON.parse 更阴 —— 文件里的 "__proto__" 会被直接当成原型吃掉，读的时候还像存在（走原型链），
 * 写出去又没了。所以这些名字一律不许当存档 id / 用户名用。
 */
export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
export function reservedKey(name) { return RESERVED_KEYS.has(String(name == null ? '' : name).toLowerCase()); }
/** 存档 id：字符集白名单 + 排除特殊 key */
export function safeId(id) {
  const v = String(id == null ? '' : id);
  return /^[A-Za-z0-9_-]{1,24}$/.test(v) && !RESERVED_KEYS.has(v);
}

/**
 * 往「id → 记录」的 map 里写东西必须用这个：`map['__proto__'] = rec` 不是新增一条记录，
 * 而是改这个对象的原型（静默、还看着像成功了）。用户名允许下划线，`__proto__` 是合法用户名，
 * 导入的备份里的存档 id 更是外部输入 —— 所以写入走 defineProperty，读取一律 hasOwn。
 */
function safePut(map, key, value) {
  Object.defineProperty(map, String(key), { value, enumerable: true, writable: true, configurable: true });
  return value;
}
const hasKey = (map, key) => !!map && Object.prototype.hasOwnProperty.call(map, String(key));

function applyAccounts(store, doc) {
  if (!doc || !doc.accounts || typeof doc.accounts !== 'object') return;
  const accounts = {};
  let dropped = 0;
  for (const [k0, acc] of Object.entries(doc.accounts)) {
    const k = JsonStore.key(k0);
    // 手改过的 accounts.json 里也可能塞进 __proto__ / 非对象值：逐个过一遍，坏的丢掉
    // （特殊 key 就算用 defineProperty 塞进去了，写回 JSON 再读回来也会变成原型 → 账号凭空消失，
    //   所以宁可丢掉，也不能让它进 map）
    if (!k || reservedKey(k) || !acc || typeof acc !== 'object' || Array.isArray(acc)) { dropped++; continue; }
    safePut(accounts, k, sanitizeAccount({ ...acc, user: acc.user || k0 }));
  }
  store.accountsDoc = { ...EMPTY_ACCOUNTS(), ...doc, accounts };
  if (dropped) console.error(`[data] accounts.json 里有 ${dropped} 条记录形状不对，已忽略（其余照常可用）`);
}
function applySaves(store, doc) {
  if (!doc || !doc.saves) return;
  const saves = {};
  let dropped = 0;
  for (const [id, run] of Object.entries(doc.saves)) {
    const clean = sanitizeRun(run, id);
    if (clean) safePut(saves, clean.id, clean);
    else dropped++;
  }
  store.savesDoc = { ...EMPTY_SAVES(), ...doc, saves };
  if (typeof store.savesDoc.seq !== 'number') store.savesDoc.seq = Object.keys(store.savesDoc.saves).length + 1;
  if (dropped) console.error(`[data] saves.json 里有 ${dropped} 条记录形状不对，已忽略（其余照常可用）`);
}

const asArray = (x) => (Array.isArray(x) ? x : []);
const asNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 存档记录可能来自手改的文件或外部备份：逐条把形状过一遍，坏条目丢掉。
 * 否则 listSaves / loadRun / forgetSave 这些读取点会在 WebSocket 回调里被 .concat() 抛出去。
 */
export function sanitizeRun(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.players !== undefined && !Array.isArray(raw.players)) return null;
  // id 也在校验范围内：`__proto__` 这种 key 进了 map 就是改原型，读档/删除/列表全会歪
  const sid = String((id && String(id)) || raw.id || '');
  if (!safeId(sid)) return null;
  const players = asArray(raw.players).filter((p) => p && typeof p === 'object' && !Array.isArray(p)).map((p) => ({
    user: String(p.user == null ? '' : p.user).slice(0, 20),
    name: String(p.name == null ? '土豆' : p.name).slice(0, 14) || '土豆',
    slot: Math.max(0, asNum(p.slot, 0) | 0),
    team: asNum(p.team, 0) | 0,
    level: Math.max(1, asNum(p.level, 1) | 0),
    xp: Math.max(0, asNum(p.xp)),
    coins: Math.max(0, asNum(p.coins)),
    kills: asNum(p.kills, 0) | 0,
    deaths: asNum(p.deaths, 0) | 0,
    damage: Math.max(0, asNum(p.damage)),
    taken: Math.max(0, asNum(p.taken)),
    hp: asNum(p.hp, 100),
    items: (p.items && typeof p.items === 'object' && !Array.isArray(p.items)) ? p.items : {},
    weapons: asArray(p.weapons).filter((x) => typeof x === 'string').slice(0, 6),
  }));
  const settings = (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) ? raw.settings : {};
  const owners = asArray(raw.owners).map((x) => String(x == null ? '' : x).slice(0, 20)).filter(Boolean);
  const by = String(raw.by == null ? '' : raw.by).slice(0, 20);
  if (by && !owners.includes(by)) owners.push(by);
  return {
    id: sid,
    v: DATA_VERSION,
    label: String(raw.label == null ? '' : raw.label).slice(0, 24),
    code: String(raw.code == null ? '' : raw.code).slice(0, 8),
    owners,
    by,
    createdAt: asNum(raw.createdAt, 0),
    updatedAt: asNum(raw.updatedAt, 0),
    mode: typeof raw.mode === 'string' ? raw.mode : String(settings.mode || 'pve'),
    settings,
    seed: asNum(raw.seed, 0) >>> 0,
    rngState: raw.rngState === undefined ? undefined : asNum(raw.rngState, 0),
    tick: asNum(raw.tick, 0) | 0,
    time: asNum(raw.time, 0),
    wave: Math.max(0, asNum(raw.wave, 0) | 0),
    players,
  };
}

/** 账号入库前的形状整理：只留认识的字段，别把乱七八糟的东西一起写进文件 */
export function sanitizeAccount(a) {
  const stats = a.stats && typeof a.stats === 'object' ? a.stats : {};
  const prefs = a.prefs && typeof a.prefs === 'object' ? a.prefs : {};
  return {
    user: String(a.user || '').slice(0, 20),
    pass: String(a.pass == null ? '' : a.pass).slice(0, 64),
    name: String(a.name || a.user || '土豆').slice(0, 14),
    session: a.session ? String(a.session).slice(0, 48) : '',
    createdAt: Number(a.createdAt) || Date.now(),
    lastLoginAt: Number(a.lastLoginAt) || 0,
    failN: Number(a.failN) || 0,
    failUntil: Number(a.failUntil) || 0,
    prefs: {
      startWeapon: typeof prefs.startWeapon === 'string' ? prefs.startWeapon.slice(0, 20) : 'pistol',
      autoSave: prefs.autoSave !== false,
    },
    stats: {
      matches: Number(stats.matches) || 0,
      wins: Number(stats.wins) || 0,
      bestWave: Number(stats.bestWave) || 0,
      kills: Number(stats.kills) || 0,
      deaths: Number(stats.deaths) || 0,
      damage: Number(stats.damage) || 0,
      playSec: Number(stats.playSec) || 0,
      endless: {
        runs: Number(stats.endless?.runs) || 0,
        bestWave: Number(stats.endless?.bestWave) || 0,
        bestTime: Number(stats.endless?.bestTime) || 0,
        bestKills: Number(stats.endless?.bestKills) || 0,
      },
    },
    saves: Array.isArray(a.saves) ? a.saves.slice(0, 40).map(String) : [],
  };
}

export class JsonStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    this.accountsDoc = EMPTY_ACCOUNTS();
    this.savesDoc = EMPTY_SAVES();
    this.dirty = new Set();
    this.chain = Promise.resolve();
    this.timer = null;
    this.closed = false;
    this.lockOwned = false;
    this.lockId = crypto.randomBytes(4).toString('hex');   // 同一进程内也要能区分两个实例
    this.lockError = '';                                    // 'busy' 或文件系统错误码
    this.lockBusy = null;
    // 每份文档一个改动计数：dirty 只有「加/删名字」两种状态，扛不住「写盘途中又改了」，
    // 靠这个代数判断落盘的那一版之后还有没有新改动
    this.gen = { accounts: 0, saves: 0 };
  }

  get accountsFile() { return path.join(this.dir, 'accounts.json'); }
  get savesFile() { return path.join(this.dir, 'saves.json'); }
  get lockFile() { return path.join(this.dir, '.lock'); }

  /** 启动时同步读一次：就两个小 JSON，省掉「数据还没好请求就进来了」那类时序坑 */
  loadSync() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    for (const [file, apply] of [[this.accountsFile, applyAccounts], [this.savesFile, applySaves]]) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) {
        if (e.code !== 'ENOENT') {
          // 手改坏 JSON 时别把服务器带下水：留一份坏文件，用空档起来
          try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
          console.error(`[data] ${path.basename(file)} 解析失败，已另存为 .corrupt-* 并改用空数据`);
        }
        doc = null;
      }
      apply(this, doc);
    }
    return this;
  }
  async load() { return this.loadSync(); }

  /** 给 CLI / 管理页提示「服务器是不是在跑」 */
  readLock() {
    try {
      const [pidRaw, id] = String(fs.readFileSync(this.lockFile, 'utf8')).trim().split(/\s+/);
      return { pid: Number(pidRaw) || 0, id: id || '' };
    } catch { return null; }
  }

  /**
   * 锁按「pid + 实例 id」认主：只看 pid 的话，同一个进程里的第二个 JsonStore（测试会这么开多个
   * 服务器）会以为锁是自己的，两个进程同时写同一批 JSON + 同一个 .tmp 文件，账号/存档就互相覆盖了。
   */
  acquireLock() {
    this.lockError = '';
    this.lockBusy = null;
    try { fs.mkdirSync(this.dir, { recursive: true }); }
    catch (e) { this.lockError = e.code || String(e); return false; }
    // 关键是用 O_EXCL「创建」而不是「先读再覆盖」：两个进程同时启动时都会看到「没锁」，
    // 读-判-写这套是没有互斥性的；open(...,'wx') 让内核只放过一个。
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd = -1;
      try {
        fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, `${process.pid} ${this.lockId}\n`);
        this.lockOwned = true;
        return true;
      } catch (e) {
        if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = -1; }
        if (e.code !== 'EEXIST') {
          // 目录只读 / 盘满 / 权限不对：这恰恰是最需要互斥的时候，不能当成「拿到锁了」
          this.lockError = e.code || String(e);
          this.lockOwned = false;
          return false;
        }
        const cur = this.readLock();
        if (cur && cur.id === this.lockId) { this.lockOwned = true; return true; }   // 自己那把，重复调用
        let alive = false;
        if (cur && cur.pid) { try { process.kill(cur.pid, 0); alive = true; } catch { alive = false; } }
        if (alive) { this.lockError = 'busy'; this.lockBusy = cur; return false; }     // 别的实例还在用
        // 僵死锁（进程早没了）：删掉重试，并发对手之间仍由 EEXIST 决出胜负
        try { fs.unlinkSync(this.lockFile); }
        catch (e2) { this.lockError = e2.code || String(e2); return false; }
      } finally {
        if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
    }
    this.lockError = 'lock-race';          // 抢了三轮还输，就别硬写别人的数据
    return false;
  }

  /** 别的进程（CLI 还原）正占着这个数据目录吗 —— 返回它的 pid（或同进程另一实例的标记） */
  static dirBusy(dir) {
    try {
      const [pidRaw, id] = String(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).trim().split(/\s+/);
      const pid = Number(pidRaw) || 0;
      if (!pid) return false;
      if (pid === process.pid) return id ? `同进程实例 ${id}` : false;
      try { process.kill(pid, 0); return pid; } catch { return false; }
    } catch { return false; }
  }

  /** 只删自己那把锁：否则第二个进程（哪怕启动失败就退出）会把第一个的锁擦掉，又变成两个进程同时写 */
  releaseLock() {
    if (!this.lockOwned) return;
    try {
      const cur = this.readLock();
      if (cur && cur.id === this.lockId) fs.unlinkSync(this.lockFile);
    } catch { /* 已经没了 */ }
    this.lockOwned = false;
  }

  // ---------------------------------------------------------------- 账号
  static key(user) { return String(user || '').trim().toLowerCase(); }

  getAccount(user) {
    const k = JsonStore.key(user);
    return k && hasKey(this.accountsDoc.accounts, k) ? this.accountsDoc.accounts[k] : null;
  }
  accountBySession(token) {
    if (!token) return null;
    for (const acc of Object.values(this.accountsDoc.accounts)) if (acc.session === token) return acc;
    return null;
  }
  accountCount() { return Object.keys(this.accountsDoc.accounts).length; }

  putAccount(acc) {
    const k = JsonStore.key(acc.user);
    if (!k || reservedKey(k)) return null;              // 特殊 key 存进去也是丢（见 applyAccounts）
    const prev = hasKey(this.accountsDoc.accounts, k) ? this.accountsDoc.accounts[k] : null;
    const rec = safePut(this.accountsDoc.accounts, k, { ...prev, ...acc, user: acc.user });
    this.mark('accounts');
    return rec;
  }
  removeAccount(user) {
    const k = JsonStore.key(user);
    if (!hasKey(this.accountsDoc.accounts, k)) return false;
    delete this.accountsDoc.accounts[k];
    this.mark('accounts');
    return true;
  }

  // ---------------------------------------------------------------- 存档点
  getSave(id) { return hasKey(this.savesDoc.saves, id) ? this.savesDoc.saves[String(id)] : null; }
  saveCount() { return Object.keys(this.savesDoc.saves).length; }
  listSaves(pred = null) {
    const all = Object.values(this.savesDoc.saves);
    const hit = pred ? all.filter(pred) : all;
    return hit.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  putSave(run) {
    // 调用方给的 id 不合规（比如 __proto__）就换发一个：宁可改名字，也不能让它污染 map
    const wanted = String(run.id || '');
    const id = safeId(wanted) ? wanted : 's' + (this.savesDoc.seq++).toString(36) + Date.now().toString(36).slice(-4);
    const rec = { ...(sanitizeRun(run, id) || run), id, v: DATA_VERSION, updatedAt: Date.now() };
    safePut(this.savesDoc.saves, id, rec);
    this.trimSaves();
    this.mark('saves');
    return rec;
  }
  deleteSave(id) {
    if (!hasKey(this.savesDoc.saves, id)) return false;
    delete this.savesDoc.saves[String(id)];
    this.mark('saves');
    return true;
  }
  /** 存档条数封顶，超了丢最老的（一条检查点才几 KB，200 条足够来回切好几轮） */
  trimSaves() {
    const list = Object.values(this.savesDoc.saves);
    if (list.length <= MAX_SAVES) return;
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const old of list.slice(0, list.length - MAX_SAVES)) { if (hasKey(this.savesDoc.saves, old.id)) delete this.savesDoc.saves[old.id]; }
  }

  // ---------------------------------------------------------------- 备份
  /** 导出一份自包含的明文备份。admin-key 故意不带（导出的文件往往会被拷来拷去） */
  exportBundle() {
    return {
      v: DATA_VERSION,
      kind: 'potato-brawl-backup',
      exportedAt: new Date().toISOString(),
      counts: { accounts: this.accountCount(), saves: this.saveCount() },
      accounts: this.accountsDoc.accounts,
      saves: this.savesDoc.saves,
      saveSeq: this.savesDoc.seq,
    };
  }

  /**
   * 还原备份。结构不对就直接拒绝 —— 宁可拒绝也别把服务器写成一坨。
   * merge=true：同名账号 / 同 id 存档用导入的这份覆盖，其余原样留着。
   */
  importBundle(bundle, { merge = false } = {}) {
    const src = bundle && typeof bundle === 'object' ? bundle : null;
    if (!src || typeof src.accounts !== 'object' || src.accounts === null) {
      throw new Error('备份格式不对：缺 accounts 字段');
    }
    if (src.kind && src.kind !== 'potato-brawl-backup') throw new Error('不是 Potato Brawl 的备份文件');
    if (src.v && src.v > DATA_VERSION) throw new Error(`备份版本 ${src.v} 比服务器支持的 ${DATA_VERSION} 新`);

    const accounts = {};
    let skipped = 0;
    for (const [k0, acc] of Object.entries(src.accounts)) {
      const k = JsonStore.key(k0);
      if (!k || reservedKey(k) || !acc || typeof acc !== 'object' || Array.isArray(acc) || typeof acc.user !== 'string') { skipped++; continue; }
      safePut(accounts, k, sanitizeAccount({ ...acc, user: acc.user || k0 }));
    }
    let rawSaves = src.saves && typeof src.saves === 'object' ? src.saves : {};
    if (Array.isArray(rawSaves)) { const o = {}; for (const item of rawSaves) if (item && item.id) safePut(o, item.id, item); rawSaves = o; }
    const saves = {};
    for (const [id, run] of Object.entries(rawSaves)) {
      const clean = sanitizeRun(run, id);
      if (!clean) { skipped++; continue; }
      safePut(saves, clean.id, clean);
    }

    if (merge) {
      this.accountsDoc.accounts = { ...this.accountsDoc.accounts, ...accounts };
      this.savesDoc.saves = { ...this.savesDoc.saves, ...saves };
      this.savesDoc.seq = Math.max(this.savesDoc.seq, Number(src.saveSeq) || 1);
    } else {
      this.accountsDoc.accounts = accounts;
      this.savesDoc.saves = saves;
      this.savesDoc.seq = Number(src.saveSeq) || (Object.keys(saves).length + 1);
    }
    this.trimSaves();
    this.mark('accounts'); this.mark('saves');
    return { accounts: Object.keys(accounts).length, saves: Object.keys(saves).length, skipped, merge };
  }

  /** 整包替换（CLI 用） */
  replaceDocs({ accounts, saves, saveSeq }) {
    // CLI 还原是「整包替换」：这里的 map 是外面读进来的原始对象，同样得先过一遍形状
    if (accounts && typeof accounts === 'object') {
      const clean = {};
      for (const [k0, acc] of Object.entries(accounts)) {
        const k = JsonStore.key(k0);
        if (!k || !acc || typeof acc !== 'object' || Array.isArray(acc) || typeof acc.user !== 'string') continue;
        safePut(clean, k, sanitizeAccount({ ...acc, user: acc.user || k0 }));
      }
      this.accountsDoc = { ...EMPTY_ACCOUNTS(), accounts: clean };
    }
    if (saves && typeof saves === 'object') {
      const clean = {};
      for (const [id, run] of Object.entries(saves)) {
        const rec = sanitizeRun(run, id);
        if (rec) safePut(clean, rec.id, rec);
      }
      this.savesDoc = { ...EMPTY_SAVES(), saves: clean, seq: saveSeq || (Object.keys(clean).length + 1) };
    }
    this.mark('accounts'); this.mark('saves');
  }

  // ---------------------------------------------------------------- 落盘
  mark(which) {
    this.gen[which] = (this.gen[which] || 0) + 1;
    this.dirty.add(which);
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => console.error('[data] 写入失败', e));
    }, 300);
    if (this.timer.unref) this.timer.unref();
  }

  async writeDoc(file, doc) { return this.writeText(file, JSON.stringify(doc, null, 2) + '\n'); }

  /** 明文 + 缩进，方便直接看和改；临时名带上进程标记，两个实例同时写不会互相踩 .tmp */
  async writeText(file, text) {
    const tmp = `${file}.${process.pid}.${this.lockId}.tmp`;
    try {
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, file);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch { /* 没建出来 */ }
      throw e;
    }
  }

  /**
   * 真正写一次盘。**只有写成功的才清脏标记** —— 先 clear 再写的话，rename 一旦失败
   * （盘满、权限、Windows 上文件被占用），内存里的改动就被当成已保存，重启全丢。
   */
  async flushOnce() {
    const which = [...this.dirty];
    if (!which.length) return { ok: true, wrote: [] };
    // 1) 先把要写的内容同步序列化下来。文档是活的（对局、登录随时在改内存对象），
    //    边 await 边 stringify 会写出「半新半旧」的状态，也分不清写完时有没有新改动。
    const now = Date.now();
    const snap = new Map();
    for (const w of which) {
      const doc = w === 'accounts' ? this.accountsDoc : this.savesDoc;
      doc.updatedAt = now;
      snap.set(w, { text: JSON.stringify(doc, null, 2) + '\n', gen: this.gen[w] });
    }
    // 2) 写盘。两份文档各自独立：accounts.json 写失败不该连累 saves.json 也跳过
    const wrote = [];
    const failed = [];
    let error = null;
    try { await fsp.mkdir(this.dir, { recursive: true }); } catch (e) { error = e; failed.push(...which); }
    for (const w of which) {
      if (error && failed.length) { failed.push(w); continue; }
      const file = w === 'accounts' ? this.accountsFile : this.savesFile;
      try { await this.writeText(file, snap.get(w).text); wrote.push(w); }
      catch (e) { error = error || e; failed.push(w); }
    }
    // 3) 只有「写完这一版之后没人再改过」才清脏标记 —— 期间被改过就留着，下一轮再写。
    //    直接 delete 会把新改动标成已保存，重启就丢了。
    for (const w of wrote) {
      if (this.gen[w] === snap.get(w).gen) this.dirty.delete(w);
      else this.staleWrites = (this.staleWrites || 0) + 1;
    }
    if (error) console.error('[data] 落盘失败，改动先留在内存里等下次重试：', error.message || error);
    return { ok: !error, wrote, failed, error };
  }

  /** 平时的落盘：串到写盘队列；失败就 2 秒后再试，不把没写成的改动标成已保存 */
  flush() {
    this.chain = this.chain.then(async () => {
      const r = await this.flushOnce();
      if (!r.ok && this.dirty.size && !this.closed) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 2000);
        if (this.timer.unref) this.timer.unref();
      }
      return r;
    });
    return this.chain;
  }

  /** 退出前要写干净：重试几次还是失败就抛出去，让启动脚本报错，而不是假装保存好了 */
  async close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    let last = { ok: true };
    for (let i = 0; i < 4 && this.dirty.size; i++) {
      last = await (this.chain = this.chain
        .then(() => this.flushOnce())
        .catch((e) => ({ ok: false, error: e })));
      if (!last.ok && this.dirty.size && i < 3) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
    this.releaseLock();
    if (this.dirty.size) {
      throw new Error(`有 ${[...this.dirty].join('/')} 没能写进 ${this.dir}：${(last.error && (last.error.code || last.error.message)) || '未知错误'}`);
    }
  }
}
