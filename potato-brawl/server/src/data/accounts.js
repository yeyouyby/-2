// 账号：注册 / 登录 / 会话 / 战绩。
//
// 明文存密码是这次需求定下来的取舍（局域网自用小服务器，数据要能直接看直接改直接备份）。
// 真要放公网，只需要改两处：register() 里存 hash、login()/changePassword() 里比 hash
// ——用 node:crypto 的 scryptSync 就行，其它逻辑（会话、锁定、战绩）都不用动。
import crypto from 'node:crypto';
import { MAX_ACCOUNTS, reservedKey, sanitizeAccount } from './store.js';

const USER_RE = /^[0-9A-Za-z_\u4e00-\u9fa5]{2,20}$/;
const PASS_MIN = 4;
const PASS_MAX = 64;
const LOCK_AFTER = 8;          // 连错这么多次就先锁一会儿，免得有人在局域网里慢慢字典试
const LOCK_SEC = 60;

export function validUser(u) {   // 返回错误文案，null 表示可用
  const s = String(u || '');
  if (!USER_RE.test(s)) return '用户名要 2-20 个字符，只能是中文、字母、数字或下划线';
  // __proto__ / constructor 这类名字在 JS 对象里不是普通 key：存进去会去改原型，
  // 写进 accounts.json 再读回来还会「看着在但取不出」。这种用户名直接不让注册。
  if (reservedKey(s)) return '这个用户名和 JS 内部属性重名，换一个';
  return null;
}
export function validPass(p) {
  const s = String(p == null ? '' : p);
  if (s.length < PASS_MIN) return `密码至少 ${PASS_MIN} 位`;
  if (s.length > PASS_MAX) return `密码最多 ${PASS_MAX} 位`;
  return null;
}

function newToken() {
  return 'pb_' + crypto.randomBytes(18).toString('base64url');
}
/** 明文存密码这件事本身已经说明这里不是威胁模型，比较还是写成常量时间的 */
function sameText(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 发给客户端的账号视图：绝不要把存了 pass 的原始对象丢进 state() */
export function publicView(acc) {
  if (!acc) return null;
  return {
    user: acc.user,
    name: acc.name,
    createdAt: acc.createdAt,
    lastLoginAt: acc.lastLoginAt,
    prefs: acc.prefs,
    stats: acc.stats,
    saves: (acc.saves || []).length,
  };
}

export class AccountService {
  constructor(store) {
    this.store = store;
  }

  get(user) { return this.store.getAccount(user); }
  bySession(token) { return this.store.accountBySession(token); }
  count() { return this.store.accountCount(); }

  register({ user, pass, name }) {
    const u = String(user || '').trim();
    const err = validUser(u) || validPass(pass);
    if (err) return { error: err };
    if (this.store.getAccount(u)) return { error: '这个用户名已经有人用了' };
    if (this.store.accountCount() >= MAX_ACCOUNTS) return { error: `账号数已达上限（${MAX_ACCOUNTS}）` };
    const acc = this.store.putAccount(sanitizeAccount({
      user: u,
      pass: String(pass),
      name: String(name || u).slice(0, 14) || u,
      session: newToken(),
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
    }));
    if (!acc) return { error: '这个用户名不可用，换一个' };     // putAccount 会拒绝 __proto__ 这类特殊 key
    return { ok: true, account: acc };
  }

  login({ user, pass }) {
    const acc = this.store.getAccount(user);
    if (!acc) return { error: '账号不存在' };
    if (acc.failUntil > Date.now()) {
      const s = Math.ceil((acc.failUntil - Date.now()) / 1000);
      return { error: `密码错太多次了，${s} 秒后再试` };
    }
    if (!sameText(acc.pass, String(pass == null ? '' : pass))) {
      acc.failN = (acc.failN || 0) + 1;
      if (acc.failN >= LOCK_AFTER) { acc.failUntil = Date.now() + LOCK_SEC * 1000; acc.failN = 0; }
      this.store.mark('accounts');
      return { error: '密码不对' };
    }
    acc.failN = 0;
    acc.failUntil = 0;
    acc.session = newToken();       // 换发新会话：旧设备上的「免密重连」就此失效（一个账号一个活会话）
    acc.lastLoginAt = Date.now();
    this.store.mark('accounts');
    return { ok: true, account: acc };
  }

  /** 客户端 localStorage 里那个 token 现在就是会话凭证：匹配上就免密登录 */
  resume(token) {
    const acc = this.store.accountBySession(token);
    if (!acc) return null;
    acc.lastLoginAt = Date.now();
    this.store.mark('accounts');
    return acc;
  }

  logout(acc) {
    if (!acc) return;
    acc.session = '';
    this.store.mark('accounts');
  }

  changePassword(acc, oldPass, newPass) {
    if (!acc) return { error: '先登录' };
    if (!sameText(acc.pass, String(oldPass == null ? '' : oldPass))) return { error: '原密码不对' };
    const err = validPass(newPass);
    if (err) return { error: err };
    acc.pass = String(newPass);
    acc.session = newToken();
    this.store.mark('accounts');
    return { ok: true, account: acc };
  }

  setPrefs(acc, patch = {}) {
    if (!acc) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) acc.name = String(patch.name).trim().slice(0, 14);
    const p = { ...acc.prefs };
    if (typeof patch.startWeapon === 'string' && /^[a-z]{1,20}$/.test(patch.startWeapon)) p.startWeapon = patch.startWeapon;
    if (typeof patch.autoSave === 'boolean') p.autoSave = patch.autoSave;
    acc.prefs = p;
    this.store.mark('accounts');
    return acc;
  }

  /** 一局结束记账（波数纪录、无尽纪录、总量统计） */
  recordMatch(user, m = {}) {
    const acc = this.store.getAccount(user);
    if (!acc) return null;
    const st = acc.stats;
    const wave = Math.max(0, Number(m.wave) || 0);
    st.matches += 1;
    if (m.win) st.wins += 1;
    st.bestWave = Math.max(st.bestWave, wave);
    st.kills += Math.max(0, Number(m.kills) || 0);
    st.deaths += Math.max(0, Number(m.deaths) || 0);
    st.damage += Math.max(0, Number(m.damage) || 0);
    st.playSec += Math.max(0, Number(m.time) || 0);
    if (m.mode === 'endless') {
      st.endless.runs += 1;
      st.endless.bestWave = Math.max(st.endless.bestWave, wave);
      st.endless.bestTime = Math.max(st.endless.bestTime, Math.round(Number(m.time) || 0));
      st.endless.bestKills = Math.max(st.endless.bestKills, Number(m.kills) || 0);
    }
    this.store.mark('accounts');
    return acc;
  }

  attachSave(user, saveId) {
    const acc = this.store.getAccount(user);
    if (!acc) return;
    acc.saves = [String(saveId), ...(acc.saves || []).filter((x) => x !== String(saveId))].slice(0, 40);
    this.store.mark('accounts');
  }
  detachSave(user, saveId) {
    const acc = this.store.getAccount(user);
    if (!acc) return;
    acc.saves = (acc.saves || []).filter((x) => x !== String(saveId));
    this.store.mark('accounts');
  }
}
