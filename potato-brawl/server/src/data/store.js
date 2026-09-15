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

function applyAccounts(store, doc) {
  if (doc && doc.accounts) store.accountsDoc = { ...EMPTY_ACCOUNTS(), ...doc, accounts: doc.accounts };
}
function applySaves(store, doc) {
  if (!doc || !doc.saves) return;
  store.savesDoc = { ...EMPTY_SAVES(), ...doc, saves: doc.saves };
  if (typeof store.savesDoc.seq !== 'number') store.savesDoc.seq = Object.keys(store.savesDoc.saves).length + 1;
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
  acquireLock() {
    try {
      const pid = Number(String(fs.readFileSync(this.lockFile, 'utf8')).trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { /* 僵死锁，抢过来 */ }
      }
    } catch { /* 没有锁文件 */ }
    try { fs.writeFileSync(this.lockFile, String(process.pid)); } catch { /* ignore */ }
    return true;
  }
  static dirBusy(dir) {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, '.lock'), 'utf8').trim());
      if (!pid || pid === process.pid) return false;
      process.kill(pid, 0);
      return pid;
    } catch { return false; }
  }
  releaseLock() { try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ } }

  // ---------------------------------------------------------------- 账号
  static key(user) { return String(user || '').trim().toLowerCase(); }

  getAccount(user) {
    const k = JsonStore.key(user);
    return k ? this.accountsDoc.accounts[k] || null : null;
  }
  accountBySession(token) {
    if (!token) return null;
    for (const acc of Object.values(this.accountsDoc.accounts)) if (acc.session === token) return acc;
    return null;
  }
  accountCount() { return Object.keys(this.accountsDoc.accounts).length; }

  putAccount(acc) {
    const k = JsonStore.key(acc.user);
    this.accountsDoc.accounts[k] = { ...this.accountsDoc.accounts[k], ...acc, user: acc.user };
    this.mark('accounts');
    return this.accountsDoc.accounts[k];
  }
  removeAccount(user) {
    const k = JsonStore.key(user);
    if (!this.accountsDoc.accounts[k]) return false;
    delete this.accountsDoc.accounts[k];
    this.mark('accounts');
    return true;
  }

  // ---------------------------------------------------------------- 存档点
  getSave(id) { return this.savesDoc.saves[String(id)] || null; }
  saveCount() { return Object.keys(this.savesDoc.saves).length; }
  listSaves(pred = null) {
    const all = Object.values(this.savesDoc.saves);
    const hit = pred ? all.filter(pred) : all;
    return hit.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  putSave(run) {
    const id = run.id || ('s' + (this.savesDoc.seq++).toString(36) + Date.now().toString(36).slice(-4));
    const rec = { ...run, id, v: DATA_VERSION, updatedAt: Date.now() };
    this.savesDoc.saves[id] = rec;
    this.trimSaves();
    this.mark('saves');
    return rec;
  }
  deleteSave(id) {
    if (!this.savesDoc.saves[String(id)]) return false;
    delete this.savesDoc.saves[String(id)];
    this.mark('saves');
    return true;
  }
  /** 存档条数封顶，超了丢最老的（一条检查点才几 KB，200 条足够来回切好几轮） */
  trimSaves() {
    const list = Object.values(this.savesDoc.saves);
    if (list.length <= MAX_SAVES) return;
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const old of list.slice(0, list.length - MAX_SAVES)) delete this.savesDoc.saves[old.id];
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
      if (!k || !acc || typeof acc !== 'object' || typeof acc.user !== 'string') { skipped++; continue; }
      accounts[k] = sanitizeAccount({ ...acc, user: acc.user || k0 });
    }
    let rawSaves = src.saves && typeof src.saves === 'object' ? src.saves : {};
    if (Array.isArray(rawSaves)) { const o = {}; for (const s of rawSaves) if (s && s.id) o[s.id] = s; rawSaves = o; }
    const saves = {};
    for (const [id, run] of Object.entries(rawSaves)) {
      if (!run || typeof run !== 'object' || !Array.isArray(run.players)) { skipped++; continue; }
      saves[String(id)] = { ...run, id: String(id), v: DATA_VERSION };
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
    if (accounts) this.accountsDoc = { ...EMPTY_ACCOUNTS(), accounts };
    if (saves) this.savesDoc = { ...EMPTY_SAVES(), saves, seq: saveSeq || (Object.keys(saves).length + 1) };
    this.mark('accounts'); this.mark('saves');
  }

  // ---------------------------------------------------------------- 落盘
  mark(which) {
    this.dirty.add(which);
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => console.error('[data] 写入失败', e));
    }, 300);
    if (this.timer.unref) this.timer.unref();
  }

  async writeDoc(file, doc) {
    const json = JSON.stringify(doc, null, 2) + '\n';     // 明文 + 缩进，方便直接看和改
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, file);
  }

  flush() {
    const which = new Set(this.dirty);
    this.dirty.clear();
    if (!which.size) return this.chain;
    const now = Date.now();
    this.chain = this.chain.then(async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      if (which.has('accounts')) { this.accountsDoc.updatedAt = now; await this.writeDoc(this.accountsFile, this.accountsDoc); }
      if (which.has('saves')) { this.savesDoc.updatedAt = now; await this.writeDoc(this.savesFile, this.savesDoc); }
    }).catch((e) => { console.error('[data] 落盘失败', e && e.message); });
    return this.chain;
  }

  async close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
    this.releaseLock();
  }
}
