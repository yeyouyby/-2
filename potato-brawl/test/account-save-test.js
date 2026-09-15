// 账号 / 检查点存档 / 备份还原 / 无尽模式 的回归测试
//   node test/account-save-test.js
//
// [1] 账号服务（注册、密码校验、锁定、会话免密登录、改密码、战绩）
// [2] 明文 JSON 存储（合并写、原子替换、损坏文件容错、存档条数上限）
// [3] 备份导出 → 导入 往返一致；坏数据被拒
// [4] Game 层：无尽模式（没有波数上限、每 10 波额外三选一、种子与随机序列接得上）
// [5] 检查点：checkpointOf → applyCheckpoint 把 build/金币/波次原样接上
// [6] 真服务器 + 真 WebSocket：未登录被拒、注册登录、自动存档落盘、跨房间读档、纪录写入
// [7] 管理接口：口令、导出下载、导入 merge、坏 JSON 拒绝
// [8] 命令行备份工具：export / verify / import 到另一个数据目录
// [9]-[11] 结算写进账号 / 管理接口细节 / CLI 子进程
// [12] 第二轮 review 的回归：存档点语义、越权删除、身份对齐、顶号、写盘失败、锁认主、坏记录容错
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

import { JsonStore, MAX_ACCOUNTS, MAX_SAVES, safeId } from '../server/src/data/store.js';
import { AccountService, publicView, validUser } from '../server/src/data/accounts.js';
import { applyCheckpoint, checkpointOf, saveSummary } from '../server/src/data/saves.js';
import { Game } from '../server/src/game/game.js';
import { cleanSettings } from '../server/src/rooms/room.js';
import { DEFAULT_SETTINGS, MODE, TICK_DT } from '../shared/constants.js';
import { createServer } from '../server/src/net/server.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ' — ' + extra : ''}`); }
};
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `pb-${tag}-`));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (args) => execFileSync('node', ['tools/data-cli.js', ...args], { encoding: 'utf8', cwd: ROOT });

// ---------------------------------------------------------------- 1. 账号
{
  console.log('\n[1] 账号服务');
  const dir = tmp('acc');
  const store = new JsonStore(dir).loadSync();
  const acc = new AccountService(store);

  ok(!validUser('土豆_1') && !!validUser('a b') && !!validUser('x'), '用户名规则：2-20 位，不许空格标点');
  const r1 = acc.register({ user: 'Player01', pass: 'abcd', name: '大土豆' });
  ok(r1.ok && r1.account.user === 'Player01' && r1.account.name === '大土豆', '注册成功，明文存密码', JSON.stringify(r1.account.pass));
  ok(r1.account.pass === 'abcd', '密码按需求明文保存（可读可改）');
  ok(!!acc.register({ user: 'player01', pass: 'zzzz' }).error, '同名（忽略大小写）不能重复注册');
  ok(!!acc.register({ user: 'ok2', pass: 'abc' }).error, '密码太短被拒');

  acc.register({ user: 'bruter', pass: 'abcd' });
  let locked = false;
  for (let i = 0; i < 12; i++) {
    const r = acc.login({ user: 'bruter', pass: 'x' });
    if (/再试/.test(r.error || '')) { locked = true; break; }
  }
  ok(locked, '连续错密码 8 次后临时锁定（防爆破）');
  ok(/密码不对/.test(acc.login({ user: 'Player01', pass: 'nope' }).error || ''), '密码错 → 拒绝');
  const l1 = acc.login({ user: 'Player01', pass: 'abcd' });
  ok(l1.ok && l1.account.session, '登录成功并发放会话 token');
  ok(acc.resume(l1.account.session)?.user === 'Player01', '会话 token 能免密恢复登录态');
  ok(!acc.resume('pb_nonsense'), '乱猜的 token 不认');

  acc.login({ user: 'Player01', pass: 'abcd' });           // 顺便把成功登录路径走一遍

  const cp = acc.changePassword(l1.account, 'abcd', 'newpass1');
  ok(cp.ok && acc.login({ user: 'Player01', pass: 'newpass1' }).ok, '改密码后新密码可用');
  ok(!!acc.changePassword(cp.account, 'wrong', 'x').error, '改密码要验原密码');

  acc.recordMatch('Player01', { mode: 'endless', wave: 33, win: false, kills: 200, deaths: 4, damage: 50000, time: 1800 });
  acc.recordMatch('Player01', { mode: 'pve', wave: 12, win: true, kills: 90, deaths: 1, damage: 20000, time: 900 });
  const a2 = acc.get('Player01');
  ok(a2.stats.matches === 2 && a2.stats.wins === 1 && a2.stats.bestWave === 33, '战绩累计正确（场次/胜场/最高波）', JSON.stringify(a2.stats));
  ok(a2.stats.endless.bestWave === 33 && a2.stats.endless.bestTime === 1800 && a2.stats.endless.runs === 1, '无尽纪录单独记一份');
  ok(JSON.stringify(publicView(a2)).indexOf('newpass1') < 0, 'publicView 不含密码（发客户端的那份）');

  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. 存储
{
  console.log('\n[2] 明文 JSON 存储');
  const dir = tmp('store');
  const store = new JsonStore(dir).loadSync();
  store.putAccount({ user: 'u1', pass: 'pp', name: 'U1', createdAt: Date.now(), prefs: { autoSave: true }, stats: { matches: 0, endless: {} }, saves: [] });
  for (let i = 0; i < 3; i++) store.putSave({ id: undefined, wave: i, by: 'u1', owners: ['u1'], players: [], createdAt: Date.now() + i });
  await store.flush();
  const rawA = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  const rawS = fs.readFileSync(path.join(dir, 'saves.json'), 'utf8');
  ok(rawA.includes('"u1"') && rawA.includes('"pp"'), '账号就是明文 JSON，能直接 cat 看');
  ok(fs.existsSync(path.join(dir, 'accounts.json.tmp')) === false, '临时文件已 rename 掉（不留半个文件）');
  ok(Object.keys(store.savesDoc.saves).length === 3, '存档写入 3 条');

  // 条数上限：超了丢最老的
  for (let i = 0; i < MAX_SAVES + 10; i++) store.putSave({ wave: 900 + i, by: 'u1', owners: ['u1'], players: [], createdAt: 1000 + i });
  ok(store.saveCount() === MAX_SAVES, `存档条数封顶 ${MAX_SAVES}`, String(store.saveCount()));
  const oldest = store.listSaves().pop();
  ok(oldest.wave >= 900 + 10, '丢的是最老的而不是最新的', String(oldest.wave));

  // 坏 JSON 容错
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{"accounts": 坏掉的');
  const reopened = new JsonStore(dir).loadSync();
  ok(Object.keys(reopened.accountsDoc.accounts).length === 0, '手改坏的 JSON 被降级成空档而不是崩掉');
  ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '坏文件被留了一份 .corrupt-* 备份');
  ok(MAX_ACCOUNTS === 5000, '账号数上限常量在（防无限注册）');

  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. 备份往返
{
  console.log('\n[3] 备份导出 / 导入');
  const dirA = tmp('ba'), dirB = tmp('bb');
  const A = new JsonStore(dirA).loadSync();
  const accA = new AccountService(A);
  accA.register({ user: 'hero', pass: '1234', name: '勇者' });
  A.putSave({ wave: 7, by: 'hero', owners: ['hero'], players: [{ name: '勇者', level: 9, coins: 200 }], createdAt: Date.now(), mode: 'endless' });
  await A.flush();
  const bundle = A.exportBundle();
  ok(bundle.kind === 'potato-brawl-backup' && bundle.counts.accounts === 1 && bundle.counts.saves === 1, '导出包结构完整');
  ok(JSON.stringify(bundle).includes('1234'), '备份里带明文密码（按需求：整包自包含，恢复就能直接登）');

  const B = new JsonStore(dirB).loadSync();
  const r = B.importBundle(JSON.parse(JSON.stringify(bundle)));
  ok(r.accounts === 1 && r.saves === 1 && !r.skipped, '导入到空目录：账号 1 存档 1');
  ok(B.getAccount('hero')?.pass === '1234', '还原后能直接登录');
  ok(B.listSaves()[0].wave === 7, '还原后存档还在');
  await B.flush();
  ok(JSON.stringify(new JsonStore(dirB).loadSync().exportBundle().accounts) === JSON.stringify(bundle.accounts), '落盘再读回，内容与导出一致');

  // 坏备份一律拒绝
  let threw = '';
  for (const bad of [{}, { accounts: 'x' }, { kind: 'other', accounts: {} }, { v: 99, accounts: {} }, { accounts: { a: 1 } }]) {
    try { new JsonStore(dirB).loadSync().importBundle(bad); } catch (e) { threw += (e.message || '') + '|'; }
  }
  ok(threw.includes('accounts') && threw.includes('版本'), '格式不对/版本过新的备份全部拒绝导入', threw.slice(0, 80));
  const pr = B.importBundle({ accounts: { x1: { user: 'x1', pass: 'pp' }, bad1: null }, saves: { okrun: { players: [], wave: 1 }, broken: 3 } });
  ok(pr.accounts === 1 && pr.saves === 1 && pr.skipped === 2, '混进来的坏数据被跳过，好数据仍然进（skipped 有计数）', JSON.stringify(pr));

  await Promise.all([A.close(), B.close()]);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4. 无尽模式（Game 层，快）
function fakeRoom(settings) {
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, seed: 4242, code: 'TEST', chat_() {}, broadcast() {} };
}
{
  console.log('\n[4] 无尽模式');
  const g = new Game(fakeRoom({ mode: MODE.ENDLESS, endlessBonusEvery: 10, prepTime: 3 }));
  const p = g.addPlayer({ id: 'p1', name: 'A', slot: 0, startWeapon: 'pistol' });
  g.start();
  ok(g.waveLimit() === 0, '无尽没有波数上限（waveLimit=0）', String(g.waveLimit()));
  ok(g.phase === 'countdown', '无尽也从倒计时开始');
  g.phase = 'prep'; g.phaseTimer = 0;
  g.update(TICK_DT);
  ok(g.wave === 1 && g.phase === 'wave', '备战结束 → 进第 1 波');

  // 直接推到第 10 波看奖励
  const g2 = new Game(fakeRoom({ mode: MODE.ENDLESS, endlessBonusEvery: 10 }));
  const p2 = g2.addPlayer({ id: 'q1', name: 'B', slot: 0, startWeapon: 'pistol' });
  g2.start();
  g2.beginWave(9);
  const before = p2.pendingLevels;
  g2.beginWave(10);
  ok(p2.pendingLevels === before + 1, '第 10 波额外给一次三选一', `pending ${before}→${p2.pendingLevels}`);
  ok(Array.isArray(p2.choices) && p2.choices.length === 3, '三选一的选项已经摇好');
  g2.beginWave(11);
  ok(p2.pendingLevels === before + 1, '非整十波不多给');
  const ev = g2.events.filter((e) => e.t === 'endlessbonus');
  ok(ev.length === 1 && ev[0].n === 10, '广播了 endlessbonus 事件（客户端要做横幅）', JSON.stringify(g2.events.map((e) => e.t)));

  // 通关判定不会被无尽触发
  const g3 = new Game(fakeRoom({ mode: MODE.ENDLESS }));
  g3.addPlayer({ id: 'r1', name: 'C', slot: 0, startWeapon: 'pistol' });
  g3.start();
  g3.wave = 999; g3.phase = 'wave'; g3.spawnQueue = []; g3.enemies = []; g3.waveClock = 5;
  g3.updateWave(TICK_DT);
  ok(g3.phase === 'prep', '第 999 波打完不会「通关结束」，而是进下一波备战', g3.phase);
  const g4 = new Game(fakeRoom({ mode: MODE.PVE, totalWaves: 20 }));
  g4.addPlayer({ id: 's1', name: 'D', slot: 0, startWeapon: 'pistol' });
  g4.start();
  g4.wave = 20; g4.phase = 'wave'; g4.spawnQueue = []; g4.enemies = []; g4.waveClock = 5;
  g4.updateWave(TICK_DT);
  ok(g4.phase === 'over', 'PvE 到 20 波仍然正常通关（没被改坏）', g4.phase);
  ok(g4.result.win === true && g4.result.reason === 'clear', '通关结果内容正常');
}

// ---------------------------------------------------------------- 5. 检查点往返
{
  console.log('\n[5] 检查点：存 → 读 一致性');
  const src = new Game(fakeRoom({ mode: MODE.PVE, totalWaves: 20, prepTime: 20 }));
  const pa = src.addPlayer({ id: 'pa', name: '阿A', slot: 0, user: 'hero' });
  const pb = src.addPlayer({ id: 'pb', name: '阿B', slot: 1, user: 'noob' });
  src.start();
  src.beginWave(3);
  pa.level = 7; pa.xp = 12; pa.coins = 480; pa.kills = 66; pa.damageDealt = 9876;
  pa.items = { armor: 2, coffee: 1 }; pa.weapons = [{ id: 'shotgun', cd: 0 }, { id: 'sword', cd: 0 }];
  src.rng(); src.rng(); src.rng();               // 让随机序列走一段
  const rngState = src.rng.getState();
  const run = checkpointOf(src, { label: '测试点', owners: ['hero', 'noob'], code: 'AAAA' });
  ok(run.wave === 3 && run.rngState === rngState && run.seed === src.seed, '检查点记下波次/种子/随机状态');
  ok(run.players.length === 2 && run.players[0].user === 'hero', '按账号归属记录了每个玩家');
  ok(run.settings.totalWaves === 20, '设置一起存下来');

  // 新房间恢复
  const dst = new Game(fakeRoom(cleanSettings(run.settings, DEFAULT_SETTINGS)));
  dst.addPlayer({ id: 'x1', name: '阿A', slot: 0, user: 'hero' });
  dst.addPlayer({ id: 'x2', name: '新来的', slot: 1, user: 'fresh' });
  dst.start();
  const res = applyCheckpoint(dst, run);
  ok(res.restored === 1 && res.wave === 3, '按账号匹配恢复了 1 人（另 1 人是新加入的）', JSON.stringify(res));
  ok(res.warnings.length >= 1, '没匹配上的人给出提示而不是静默');
  const qa = dst.players.get('x1');
  ok(qa.level === 7 && qa.coins === 480 && qa.kills === 66, '等级/金币/击杀原样接上');
  ok(qa.items.armor === 2 && qa.items.coffee === 1, '道具数量接上');
  ok(qa.weapons.map((w) => w.id).join() === 'shotgun,sword', '武器接上（含顺序）', qa.weapons.map((w) => w.id).join());
  ok(qa.stats.atkSpeed > 1 && qa.stats.armor > 0, '道具属性重算过（coffee 攻速 / armor 护甲）', JSON.stringify({ as: qa.stats.atkSpeed, ar: qa.stats.armor }));
  ok(dst.wave === 3 && dst.phase === 'prep', '停在第 4 波开始前的商店阶段', `${dst.wave}/${dst.phase}`);
  // 存档点连随机序列一起接上：同一份存档读两次，下一波的出场队列必须一模一样
  const dst2 = new Game(fakeRoom(cleanSettings(run.settings, DEFAULT_SETTINGS)));
  dst2.addPlayer({ id: 'y1', name: '阿A', slot: 0, user: 'hero' });
  dst2.addPlayer({ id: 'y2', name: '新来的', slot: 1, user: 'fresh' });
  dst2.start();
  applyCheckpoint(dst2, run);
  dst.beginWave(4); dst2.beginWave(4);
  ok(JSON.stringify(dst.spawnQueue) === JSON.stringify(dst2.spawnQueue) && dst.spawnQueue.length > 0,
    '同一份存档读两次 → 第 5 波出场队列完全一致（随机序列真的接上了）', `${dst.spawnQueue.length}/${dst2.spawnQueue.length}`);
  ok(dst.players.get('x2').weapons.length >= 1, '新加入的人有自己的开局武器');
  const sum = saveSummary({ id: 's1', wave: 3, mode: 'pve', createdAt: 1, players: [] });
  ok(sum.wave === 4 && sum.label === 'PvE 第 4 波前', '没写 label 时摘要兜底成「第 N 波前」', JSON.stringify(sum));
  const sum2 = saveSummary({ ...run, id: 's2', createdAt: Date.now() });
  ok(sum2.label === '测试点' && sum2.players.length === 2, '有 label 时用存档自己的标签', JSON.stringify(sum2.label));
}

// ---------------------------------------------------------------- 6/7. 真服务器端到端
function track(ws) {
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred(m)) { clearTimeout(w.timer); waiters.splice(i, 1); w.resolve(m); }
    }
  });
  return {
    msgs,
    clear() { msgs.length = 0; },
    wait(pred, timeout = 6000) {
      return new Promise((resolve) => {
        const seen = msgs.find(pred);
        if (seen) { resolve(seen); return; }
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve({ __miss: true, got: msgs.map((m) => m.t).join(',') });
        }, timeout);
        waiters.push(w);
      });
    },
  };
}
const miss = (m) => (m && m.__miss ? `没等到（收到：${m.got}）` : '');
const dataDir = tmp('srv');
const { server, manager, store, adminKey, stop } = createServer({ dataDir, adminKey: 'test-admin-key' });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const api = (method, p, body, key = 'test-admin-key') => new Promise((resolve) => {
  const req = http.request({ port, path: p, method, headers: key ? { 'x-pb-admin': key, 'content-type': 'application/json' } : {} }, (res) => {
    let t = '';
    res.on('data', (c) => { t += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: t, headers: res.headers }));
  });
  req.on('error', (e) => resolve({ status: 0, body: String(e.code), headers: {} }));
  if (body) req.write(body);
  req.end();
});

try {
  console.log('\n[6] 登录闸门与账号');
  const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const A = track(a);
  await new Promise((r) => a.once('open', r));
  a.send(JSON.stringify({ t: 'hello', name: '阿A', token: 'random-old-token' }));
  const w1 = await A.wait((m) => m.t === 'welcome');
  ok(!w1.__miss && w1.account === null && w1.needLogin === true, '老 token 不算登录：welcome 里明确要登录', JSON.stringify(w1).slice(0, 120));
  a.send(JSON.stringify({ t: 'create', roomName: '我的房' }));
  const blocked = await A.wait((m) => m.t === 'needLogin' || m.t === 'joined');
  ok(blocked.t === 'needLogin', '未登录不能建房', JSON.stringify(blocked));
  a.send(JSON.stringify({ t: 'login', user: 'nobody', pass: 'abcd' }));
  const bad = await A.wait((m) => m.t === 'account' && m.ok === false);
  ok(bad.error === '账号不存在', '登录不存在的账号 → 明确报错', JSON.stringify(bad));

  a.send(JSON.stringify({ t: 'register', user: 'hero', pass: 'abcd', name: '勇者阿A' }));
  const reg = await A.wait((m) => m.t === 'account' && m.action === 'register');
  ok(reg.ok && reg.account.user === 'hero' && reg.account.name === '勇者阿A', '注册即登录');
  ok(!JSON.stringify(reg.account).includes('abcd'), '注册响应里不带密码');
  const session = reg.token;
  a.send(JSON.stringify({ t: 'create', roomName: '勇者的房' }));
  const joined = await A.wait((m) => m.t === 'joined');
  ok(!joined.__miss, '登录后可以建房', miss(joined));
  const code = joined.code;

  // 会话免密：重开一条 socket 用 session token 直接恢复
  const a2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const A2 = track(a2);
  await new Promise((r) => a2.once('open', r));
  a2.send(JSON.stringify({ t: 'hello', name: '随便', token: session }));
  const w2 = await A2.wait((m) => m.t === 'welcome');
  ok(w2.account && w2.account.user === 'hero' && w2.needLogin !== true, '刷新页面（同一个会话 token）自动恢复登录', JSON.stringify(w2.account));
  a2.close();

  console.log('\n[7] 自动存档 / 手动存档 / 跨房间读档');
  a.send(JSON.stringify({ t: 'ready', v: true }));
  await A.wait((m) => m.t === 'room' && m.room.players[0].ready);
  a.send(JSON.stringify({ t: 'start' }));
  const st = await A.wait((m) => m.t === 'start');
  ok(!st.__miss, '开局', miss(st));
  const room = manager.getRoom(code);
  ok(room && room.game, '服务器侧房间已有对局');
  // 直接把对局推到「备战」，让自动存档按正常路径触发
  room.game.phase = 'prep';
  room.game.phaseTimer = 0.01;
  room.game.beginPrep();
  const savedAuto = await A.wait((m) => m.t === 'saved', 4000);
  ok(!savedAuto.__miss && savedAuto.auto === true, '进商店那一刻自动写了检查点并广播 saved', JSON.stringify(savedAuto));
  await store.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'saves.json'), 'utf8'));
  ok(Object.keys(onDisk.saves).length === 1, 'saves.json 里确实落了 1 条', JSON.stringify(Object.keys(onDisk.saves)));
  ok(String(fs.readFileSync(path.join(dataDir, 'saves.json'), 'utf8')).includes('\n  "saves"'), '文件是缩进过的明文 JSON（能直接看能手改）');

  // 给玩家一点成长；先在「波中」手存、再在「商店里」手存 —— 两者语义不同
  const gp = room.game.players.get(w1.id);
  room.game.beginWave(4);                       // 第 4 波正在打
  gp.level = 6; gp.xp = 30; gp.coins = 300; gp.items = { apple: 2 }; gp.weapons = [{ id: 'smg', cd: 0 }];
  a.send(JSON.stringify({ t: 'saveNow' }));
  const savedMan = await A.wait((m) => m.t === 'saved' && !m.auto);
  ok(!savedMan.__miss, '房主可以手动存档', miss(savedMan));
  const saveId = savedMan.id;
  const midRun = store.getSave(saveId);
  ok(midRun.wave === 3 && /本波重打/.test(midRun.label),
    '波中手存记的是「第 4 波从头打」：不会把正在打的这一波白送过去', JSON.stringify([midRun.wave, midRun.label]));
  a.send(JSON.stringify({ t: 'saves' }));
  const list = await A.wait((m) => m.t === 'saveList');
  ok(list.saves && list.saves.length === 2 && list.saves.some((x) => x.id === saveId), '存档列表有两条（自动 + 手动）', JSON.stringify(list.saves && list.saves.map((x) => x.wave)));

  // 商店里再存一次 → 「下一波开始前」，而且是独立的一条记录
  room.game.phase = 'prep';
  A.clear();
  a.send(JSON.stringify({ t: 'saveNow' }));
  const savedPrep = await A.wait((m) => m.t === 'saved' && !m.auto);
  const prepRun = store.getSave(savedPrep.id);
  ok(prepRun && prepRun.wave === 4 && /第 5 波前/.test(prepRun.label), '商店里手存记的是「第 5 波前」', JSON.stringify(prepRun && [prepRun.wave, prepRun.label]));
  ok(savedPrep.id !== saveId, '两次手存是两条检查点，不互相覆盖');

  A.clear();
  a.send(JSON.stringify({ t: 'leave' }));
  a.send(JSON.stringify({ t: 'create', roomName: '第二个房' }));
  const j2 = await A.wait((m) => m.t === 'joined' && m.code !== code);
  ok(!j2.__miss, '建了第二个房间', miss(j2));
  A.clear();
  a.send(JSON.stringify({ t: 'saveLoad', id: saveId }));
  const loaded = await A.wait((m) => m.t === 'loaded');
  ok(!loaded.__miss && loaded.wave === 4 && loaded.restored === 1, '读「波中检查点」→ 第 4 波重打，1 人的 build 接上', JSON.stringify(loaded));
  const snap = await A.wait((m) => m.t === 'snap' && m.me, 6000);
  ok(!snap.__miss && snap.ph === 'prep' && snap.w === 3, '快照：停在商店阶段、已完成 3 波', String(snap.ph) + '/' + String(snap.w));
  A.clear();
  a.send(JSON.stringify({ t: 'saveLoad', id: savedPrep.id }));
  const loaded2 = await A.wait((m) => m.t === 'loaded');
  ok(loaded2.wave === 5, '读「商店检查点」→ 从第 5 波继续（正常推进语义没被改坏）', JSON.stringify(loaded2));
  ok(snap.me && snap.me.lv === 6 && snap.me.coins === 300, '等级与金币从存档点恢复', JSON.stringify(snap.me && { lv: snap.me.lv, coins: snap.me.coins }));
  ok(snap.me.it && snap.me.it.apple === 2, '道具恢复了');
  ok(snap.me.w && snap.me.w[0].id === 'smg', '武器恢复了', JSON.stringify(snap.me && snap.me.w));

  // 权限：不是自己的存档不能读
  const thief = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const T = track(thief);
  await new Promise((r) => thief.once('open', r));
  thief.send(JSON.stringify({ t: 'hello', name: '贼', token: 't2' }));
  await T.wait((m) => m.t === 'welcome');
  thief.send(JSON.stringify({ t: 'register', user: 'thief', pass: 'abcd' }));
  await T.wait((m) => m.t === 'account' && m.action === 'register');
  thief.send(JSON.stringify({ t: 'create', roomName: '贼窝' }));
  await T.wait((m) => m.t === 'joined');
  thief.send(JSON.stringify({ t: 'saves' }));
  const tlist = await T.wait((m) => m.t === 'saveList');
  ok(tlist.saves && tlist.saves.length === 0, '别人的存档不在你的列表里', JSON.stringify(tlist.saves));
  thief.send(JSON.stringify({ t: 'saveLoad', id: saveId }));
  const denied = await T.wait((m) => m.t === 'err');
  ok(denied.msg && /不是你的存档/.test(denied.msg), '拿别人的 id 也读不了', JSON.stringify(denied));
  thief.close();

  console.log('\n[8] 无尽模式（走真协议）');
  A.clear();
  a.send(JSON.stringify({ t: 'leave' }));
  a.send(JSON.stringify({ t: 'create', roomName: '无尽房' }));
  const j3 = await A.wait((m) => m.t === 'joined' && m.code !== j2.code);
  ok(!j3.__miss, '开了第三个房间（对局中不让改设置，所以换个干净房间）', miss(j3));
  a.send(JSON.stringify({ t: 'settings', settings: { mode: 'endless', totalWaves: 999999, difficulty: 5 } }));
  const setOk = await A.wait((m) => m.t === 'room' && m.room.settings.mode === 'endless');
  ok(!setOk.__miss, 'lobby 里可以把模式切成无尽', miss(setOk));
  ok(setOk.room.settings.difficulty === 3 && setOk.room.settings.totalWaves === 60,
    '无尽下的越界设置照样被夹住（difficulty 5→3、totalWaves 999999→60）', JSON.stringify([setOk.room.settings.difficulty, setOk.room.settings.totalWaves]));
  a.send(JSON.stringify({ t: 'ready', v: true }));
  a.send(JSON.stringify({ t: 'start' }));
  const st2 = await A.wait((m) => m.t === 'start' && m.mode === 'endless');
  ok(!st2.__miss, '无尽模式能开局', miss(st2));
  const room3 = manager.getRoom(j3.code);
  ok(room3 && room3.game.waveLimit() === 0, '服务器侧无尽没有上限');
  room3.game.beginWave(10);
  await new Promise((r) => setTimeout(r, 60));
  ok(room3.game.players.get(w1.id).pendingLevels >= 1, '第 10 波的额外三选一走到了真人身上');
  ok(room3.game.players.get(w1.id).choices && room3.game.players.get(w1.id).choices.length === 3, '弹出了三选一卡片');

  console.log('\n[9] 结算写进账号');
  const g3 = room3.game;
  g3.endGame(false, 'wipe');
  room3.overTimer = 0;
  room3.tick(TICK_DT);
  await store.flush();
  await new Promise((r) => setTimeout(r, 400));      // 等服务器的 tick/落盘追上
  await store.flush();
  const accDoc = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')).accounts.hero;
  ok(accDoc.stats.matches >= 1, '场次写进账号了', JSON.stringify(accDoc.stats));
  ok(accDoc.stats.endless.runs >= 1 && accDoc.stats.endless.bestWave >= 10, '无尽纪录写进账号', JSON.stringify(accDoc.stats.endless));
  ok(accDoc.saves.length >= 1, '账号上挂着存档 id', JSON.stringify(accDoc.saves));

  console.log('\n[10] 管理接口');
  const noKey = await api('GET', '/admin/stats', null, '');
  ok(noKey.status === 401, '没口令 → 401', String(noKey.status));
  const wrongKey = await api('GET', '/admin/stats', null, 'guess');
  ok(wrongKey.status === 401, '口令错 → 401');
  const page = await api('GET', '/admin', null, '');
  ok(page.status === 200 && page.body.includes('导入还原'), '管理页不要口令也能打开（只是没口令什么都干不了）', String(page.status));
  const stats = await api('GET', '/admin/stats', null, 'test-admin-key');
  ok(stats.status === 200 && JSON.parse(stats.body)['账号'] === 2, '摘要：两个账号', stats.body.replace(/\s+/g, ' '));
  const exp = await api('GET', '/admin/export', null, 'test-admin-key');
  const bundle = JSON.parse(exp.body);
  ok(exp.status === 200 && bundle.kind === 'potato-brawl-backup' && bundle.counts.accounts === 2 && bundle.counts.saves >= 2, '导出的 JSON 账号/存档都在', JSON.stringify(bundle.counts));
  ok(/attachment/.test(exp.headers['content-disposition'] || '') && /potato-brawl-backup-/.test(exp.headers['content-disposition'] || ''), '导出带 attachment 文件名（浏览器直接下载）', String(exp.headers['content-disposition']));
  const badImport = await api('POST', '/admin/import', '{"nope":1}', 'test-admin-key');
  ok(badImport.status === 400 && /accounts/.test(badImport.body), '坏备份被拒绝，不落盘', String(badImport.body).slice(0, 70));
  const rollbackBefore = fs.readdirSync(dataDir).filter((f) => f.startsWith('backup-before-import-'));
  const mergeImport = await api('POST', '/admin/import?merge=1', JSON.stringify({ kind: 'potato-brawl-backup', v: 1, accounts: { newcomer: { user: 'newcomer', pass: 'abcd', name: '新人', stats: {} } }, saves: {} }), 'test-admin-key');
  ok(mergeImport.status === 200 && JSON.parse(mergeImport.body).imported.accounts === 1, 'merge 导入成功', mergeImport.body.replace(/\s+/g, ' '));
  await store.flush();
  ok(fs.existsSync(path.join(dataDir, 'accounts.json')) && JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')).accounts.newcomer, 'merge 没把原账号冲掉');
  const fullImport = await api('POST', '/admin/import', JSON.stringify(bundle), 'test-admin-key');
  ok(fullImport.status === 200 && JSON.parse(fullImport.body).rollback, '覆盖式导入前先写了回滚备份', fullImport.body.replace(/\s+/g, ' ').slice(0, 120));
  const rb = JSON.parse(fullImport.body).rollback;
  ok(rb && fs.existsSync(rb), '回滚文件真实存在：' + path.basename(rb || ''));
  ok(fs.readdirSync(dataDir).filter((f) => f.startsWith('backup-before-import-')).length > rollbackBefore.length, '每次覆盖导入都留一份');

  console.log('\n[11] 命令行备份工具');
  const cliOut = path.join(dataDir, 'cli-export.json');
  const out = cli(['export', '--data-dir', dataDir, '--out', cliOut]);
  ok(/已导出/.test(out), 'npm run backup 走通', out.trim().split('\n')[1]);
  const v1 = cli(['verify', cliOut]);
  ok(/备份可用/.test(v1), 'verify 说这份备份可用', v1.trim());
  const dirC = tmp('clicopy');
  const imp = cli(['import', cliOut, '--data-dir', dirC]);
  ok(/导入完成/.test(imp), 'import 到新目录成功', imp.trim().split('\n')[0]);
  const listC = cli(['list', '--data-dir', dirC]);
  ok(/账号 2 个/.test(listC) && /hero/.test(listC), 'list 能对上新目录', listC.split('\n').slice(2, 4).join(' | '));
  let refused = false;
  try {
    fs.writeFileSync(path.join(dirC, '.lock'), String(process.pid === 1 ? 999999 : process.pid));   // 伪造「服务器在跑」
    execFileSync('node', ['tools/data-cli.js', 'import', cliOut, '--data-dir', dirC], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT });
  } catch (e) { refused = /服务器正在跑/.test(String(e.stdout) + String(e.stderr)); }
  ok(refused, '服务器在跑时 CLI 拒绝 import（防抢文件）');
  fs.rmSync(dirC, { recursive: true, force: true });

  // ============================================================
  console.log('\n[12] 本轮 review 的修复回归');

  // ---- 波中存过之后，本波打完仍会自动存一次（去重标记带阶段） ----
  {
    A.clear();
    a.send(JSON.stringify({ t: 'create', roomName: '去重测试房' }));
    const j4 = await A.wait((m) => m.t === 'joined');
    ok(!!j4.code, '为去重测试单开一个房间', miss(j4));
    a.send(JSON.stringify({ t: 'ready', v: true }));
    a.send(JSON.stringify({ t: 'start' }));
    await A.wait((m) => m.t === 'start');
    const roomW = manager.getRoom(j4.code);
    roomW.game.phase = 'prep';
    roomW.game.wave = 6;
    roomW.lastCheckpointTag = 'w6';              // 假装「这一波中途手存过」
    const before = store.saveCount();
    roomW.tick(1 / 60);
    const autoAfterMid = store.listSaves().find((r) => r.wave === 6 && /第 7 波前/.test(r.label));
    ok(!!autoAfterMid && store.saveCount() === before + 1,
      '波中存过之后，这一波清完进商店还会自动存一次（不被去重标记吞掉）', JSON.stringify([before, store.saveCount()]));
    ok(roomW.lastCheckpointTag === 'p6', '去重标记换成了「商店 + 第 6 波」', roomW.lastCheckpointTag);
    roomW.tick(1 / 60);
    ok(store.saveCount() === before + 1, '同一波同一阶段不重复写盘', String(store.saveCount()));
  }

  // ---- 形状奇怪的存档记录：入口规范化，读的一侧不抛 ----
  store.putSave({ id: 'weird1', wave: 1, owners: 'hero', by: 'hero', players: [{ name: '甲', items: 'x', weapons: 'no' }], createdAt: Date.now() });
  A.clear();
  a.send(JSON.stringify({ t: 'saves' }));
  const listWeird = await A.wait((m) => m.t === 'saveList');
  ok(!!listWeird.saves && listWeird.saves.some((x) => x.id === 'weird1'),
    'owners 是字符串 / items 不是对象的记录被规范化后仍能列出，不会把 WebSocket 回调抛出去', miss(listWeird));
  const weird = store.getSave('weird1');
  ok(Array.isArray(weird.owners) && weird.owners.includes('hero') && typeof weird.players[0].items === 'object' && Array.isArray(weird.players[0].weapons),
    '进内存前就洗过一遍：owners→数组、items→对象、weapons→字符串数组', JSON.stringify([weird.owners, weird.players[0].items, weird.players[0].weapons]));
  {
    const dirBad = tmp('badrun');
    fs.writeFileSync(path.join(dirBad, 'saves.json'), JSON.stringify({
      v: 1,
      saves: { ok1: { wave: 2, owners: ['hero'], players: [{ name: '甲', level: 3 }] }, nul: null, bad: { players: 3 } },
    }));
    const sB = new JsonStore(dirBad).loadSync();
    ok(sB.saveCount() === 1, '读盘时坏记录被丢弃，好记录照常可用（不拖垮整份 saves.json）', String(sB.saveCount()));
    fs.rmSync(dirBad, { recursive: true, force: true });
  }

  // ---- 落盘失败：脏标记保留 + close 报错 ----
  {
    const dirF = tmp('flushfail');
    const sF = new JsonStore(dirF).loadSync();
    sF.closed = true;                                  // 自己控制写入时机，不让后台定时器插一脚
    sF.putAccount({ user: 'keepme', pass: 'abcd', name: 'K', session: 's1', prefs: {}, stats: {}, saves: [] });
    fs.mkdirSync(path.join(dirF, 'accounts.json'));    // 用同名目录占位，rename 必失败
    const r1 = await sF.flushOnce();
    ok(r1.ok === false && sF.dirty.has('accounts'), '写失败时脏标记保留（不会被当成「已保存」）', JSON.stringify(r1.wrote));
    fs.rmdirSync(path.join(dirF, 'accounts.json'));
    const r2 = await sF.flushOnce();
    ok(r2.ok && !sF.dirty.has('accounts') && JSON.parse(fs.readFileSync(path.join(dirF, 'accounts.json'), 'utf8')).accounts.keepme,
      '障碍清掉后重试把同一份改动写下去了，数据没丢');
    sF.putSave({ wave: 1, owners: ['keepme'], players: [] });
    fs.mkdirSync(path.join(dirF, 'saves.json'));
    let threwClose = false;
    try { await sF.close(); } catch { threwClose = true; }
    ok(threwClose, '退出时仍写不进去 → 抛错让启动脚本报错，而不是静默丢掉账号/存档');
    fs.rmdirSync(path.join(dirF, 'saves.json'));
    fs.rmSync(dirF, { recursive: true, force: true });
  }

  // ---- data/.lock 认主 ----
  {
    const dirL = tmp('lock');
    const L1 = new JsonStore(dirL).loadSync();
    const L2 = new JsonStore(dirL).loadSync();
    ok(L1.acquireLock() === true && L2.acquireLock() === false, '第二个实例拿不到同一个数据目录的锁');
    L2.releaseLock();
    ok(fs.existsSync(path.join(dirL, '.lock')), '非持锁者 releaseLock 不会删掉别人的锁（不会误放开第二个服务器）');
    ok(JsonStore.dirBusy(dirL) !== false, 'dirBusy 能看出目录被占（命令行还原靠它拒绝写入）');
    L1.releaseLock();
    ok(!fs.existsSync(path.join(dirL, '.lock')) && L2.acquireLock() === true, '持锁者退出后锁被释放，别人能接手');
    L2.releaseLock();
    fs.rmSync(dirL, { recursive: true, force: true });
  }

  // ---- 读档的显示名兜底：不再把别人的 build 送给同名的人 ----
  {
    const settings = cleanSettings({ mode: 'pve' }, DEFAULT_SETTINGS);
    const gS = new Game(fakeRoom(settings));
    gS.addPlayer({ id: 'zz1', name: '公用名', slot: 0, user: 'attacker' });
    gS.start();
    const rs = applyCheckpoint(gS, {
      wave: 2, seed: 7, settings,
      players: [{ user: 'victim', name: '公用名', level: 77, coins: 9999, items: { armor: 5 }, weapons: ['sniper'], hp: 500 }],
    });
    ok(rs.restored === 0, '存档记录的用户不在这个房间里 → 谁也不给他这一套 build', JSON.stringify(rs.warnings));
    ok(gS.players.get('zz1').level === 1 && gS.players.get('zz1').coins === 0, '同名的另一个人没有白拿 77 级');
    const gT = new Game(fakeRoom(settings));
    gT.addPlayer({ id: 'zz2', name: '游客甲', slot: 0 });
    gT.start();
    const rt = applyCheckpoint(gT, { wave: 1, seed: 9, settings, players: [{ user: '', name: '游客甲', level: 9, coins: 50, items: {}, weapons: ['sword'] }] });
    ok(rt.restored === 1 && gT.players.get('zz2').level === 9, '没有账号归属的老存档仍按显示名恢复', JSON.stringify(rt));
  }

  // ---- 别处登录会撤销旧连接的账号能力 ----
  const c = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const C = track(c);
  await new Promise((r) => c.on('open', r));
  c.send(JSON.stringify({ t: 'hello', protocol: 1, name: '多设备', token: 'tok-m' }));
  await C.wait((m) => m.t === 'welcome');
  c.send(JSON.stringify({ t: 'register', user: 'multi', pass: 'abcd', name: '多设备' }));
  const multiReg = await C.wait((m) => m.t === 'account' && m.ok);
  ok(!!multiReg.token, '注册 multi 成功（拿到会话 token）');
  c.send(JSON.stringify({ t: 'create', roomName: '设备一' }));
  const cJoin = await C.wait((m) => m.t === 'joined');
  ok(!!cJoin.code, 'multi 能建房', miss(cJoin));
  const cRoom = manager.getRoom(cJoin.code);
  const cKey = [...cRoom.players.keys()][0];
  ok(cRoom.players.get(cKey).user === 'multi', '房间成员挂着账号归属');

  const c2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const C2 = track(c2);
  await new Promise((r) => c2.on('open', r));
  c2.send(JSON.stringify({ t: 'hello', protocol: 1, name: '第二台', token: 'tok-m2' }));
  await C2.wait((m) => m.t === 'welcome');
  C2.clear();
  c2.send(JSON.stringify({ t: 'login', user: 'multi', pass: 'abcd' }));
  const reLogin = await C2.wait((m) => m.t === 'account' && m.ok);
  ok(!!reLogin.account && reLogin.account.user === 'multi', '同一账号在另一处登录成功（会话换发）', miss(reLogin));
  const rev = await C.wait((m) => m.t === 'account' && m.action === 'revoked', 4000);
  ok(!rev.__miss, '旧连接当场收到「账号已在别处登录」的通知（不用等它下一次操作才发现）', miss(rev));
  C.clear();
  c.send(JSON.stringify({ t: 'saveNow' }));
  const needRe = await C.wait((m) => m.t === 'needLogin');
  ok(!needRe.__miss, '旧连接再动账号相关操作会被要求重新登录，而不是写进这个账号', miss(needRe));
  ok(cRoom.players.has(cKey), '但它在对局里的位置没被踢掉');
  c2.close();

  // ---- 登录状态下掉线重连能回到原房间（token 语义对齐） ----
  const d = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const D = track(d);
  await new Promise((r) => d.on('open', r));
  d.send(JSON.stringify({ t: 'hello', protocol: 1, name: '重连号', token: 'tok-d' }));
  await D.wait((m) => m.t === 'welcome');
  d.send(JSON.stringify({ t: 'register', user: 'recon', pass: 'abcd', name: '重连号' }));
  const regD = await D.wait((m) => m.t === 'account' && m.ok);
  const sessionToken = regD.token;
  d.send(JSON.stringify({ t: 'create', roomName: '重连房' }));
  const dJoin = await D.wait((m) => m.t === 'joined');
  d.send(JSON.stringify({ t: 'ready', v: true }));
  d.send(JSON.stringify({ t: 'start' }));
  await D.wait((m) => m.t === 'start');
  d.close();                                        // 模拟掉线
  await new Promise((r) => setTimeout(r, 150));
  const d2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const D2 = track(d2);
  await new Promise((r) => d2.on('open', r));
  D2.clear();
  d2.send(JSON.stringify({ t: 'hello', protocol: 1, name: '重连号', token: sessionToken }));
  const wD2 = await D2.wait((m) => m.t === 'welcome');
  ok(wD2.account && wD2.account.user === 'recon', '重连时用登录后的 token 免密认出账号', JSON.stringify(wD2.account && wD2.account.user));
  const back = await D2.wait((m) => (m.t === 'room' && m.room) || m.t === 'joined', 4000);
  const backCode = back.t === 'room' ? back.room.code : back.code;
  ok(backCode === dJoin.code, '掉线后重连回到原来那个房间，而不是被请回大厅', JSON.stringify([back.t, backCode, dJoin.code]));
  const rD = manager.getRoom(dJoin.code);
  const dKey = [...rD.players.keys()][0];
  ok(rD.players.get(dKey).token === sessionToken, '房间成员手里的 token 也换成了会话 token（下次重连还认得）', rD.players.get(dKey).token === sessionToken ? '' : 'still 握手 token');
  ok(rD.players.get(dKey).connected === true, '房间侧 connected 恢复了');
  D2.clear();
  d2.send(JSON.stringify({ t: 'saveNow' }));
  const d2Save = await D2.wait((m) => m.t === 'saved', 4000);
  ok(!d2Save.__miss, '重连后的连接照样能存档', miss(d2Save));
  d2.close();

  // ---- 在房间里才登录：身份字段一起换 + 重复 join 不重置 + 战绩归属 ----
  const e = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const E = track(e);
  await new Promise((r) => e.on('open', r));
  e.send(JSON.stringify({ t: 'hello', protocol: 1, name: '早进场', token: 'tok-e' }));
  await E.wait((m) => m.t === 'welcome');
  e.send(JSON.stringify({ t: 'register', user: 'early', pass: 'abcd', name: '早进场' }));
  await E.wait((m) => m.t === 'account' && m.ok);
  e.send(JSON.stringify({ t: 'create', roomName: '中途登录' }));
  const eJoin = await E.wait((m) => m.t === 'joined');
  e.send(JSON.stringify({ t: 'ready', v: true }));
  e.send(JSON.stringify({ t: 'start' }));
  await E.wait((m) => m.t === 'start');
  const roomE = manager.getRoom(eJoin.code);
  const eId = [...roomE.players.keys()][0];
  E.clear();                       // 别把上一个 register 的回执当成这次的
  e.send(JSON.stringify({ t: 'register', user: 'late', pass: 'abcd', name: '改名了' }));
  const lateAcc = await E.wait((m) => m.t === 'account' && m.ok && m.account && m.account.user === 'late');
  ok(!!lateAcc.account && lateAcc.account.user === 'late', '这条连接在房间中途改登另一个账号', JSON.stringify(lateAcc).slice(0, 90));
  const npE = roomE.players.get(eId);
  ok(npE.user === 'late' && npE.name === '改名了' && npE.token === lateAcc.token,
    '房间成员的 user / name / token 一起对齐（掉线重连才能继续认人）', JSON.stringify([npE.user, npE.name, npE.token === lateAcc.token]));
  ok(roomE.game.players.get(eId).user === 'late', '对局里的玩家也换了归属（战绩不会记到旧账号头上）');
  {
    const gpE = roomE.game.players.get(eId);
    gpE.hp = 4;
    E.clear();
    e.send(JSON.stringify({ t: 'join', code: eJoin.code, name: '换了个名' }));
    const reJoin = await E.wait((m) => m.t === 'joined');
    ok(!!reJoin.code && reJoin.code === eJoin.code, '对自己已在的房间重复 join：当重连接待', miss(reJoin));
    ok(roomE.game.players.get(eId) === gpE && gpE.hp < gpE.maxHp, '角色没被重建：血没回满、没被拉回出生点', String(gpE.hp));
    ok(roomE.players.get(eId).host === true, '房主标记还在（房间非空时不该被冲掉）');
    ok(roomE.players.size === 1, '也没多出个成员');
    roomE.game.endGame(false, 'wipe');
    await new Promise((r) => setTimeout(r, 300));
    const accDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')).accounts;
    ok(accDisk.late && accDisk.late.stats.matches === 1 && (!accDisk.early || !accDisk.early.stats.matches),
      '这局战绩记在换后的账号上，旧账号没被冒领', JSON.stringify({ late: accDisk.late && accDisk.late.stats.matches, early: accDisk.early && accDisk.early.stats.matches }));
  }

  // ---- 房主不能删别人的存档 ----
  const f = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const F = track(f);
  await new Promise((r) => f.on('open', r));
  f.send(JSON.stringify({ t: 'hello', protocol: 1, name: '贼', token: 'tok-f' }));
  await F.wait((m) => m.t === 'welcome');
  f.send(JSON.stringify({ t: 'register', user: 'thief3', pass: 'abcd', name: '贼' }));
  await F.wait((m) => m.t === 'account' && m.ok);
  f.send(JSON.stringify({ t: 'create', roomName: '贼窝' }));
  await F.wait((m) => m.t === 'joined');
  F.clear();
  f.send(JSON.stringify({ t: 'saveDelete', id: saveId }));
  const stealDel = await F.wait((m) => m.t === 'err' || m.t === 'saveList');
  ok(!!store.getSave(saveId) && /只能删自己名下/.test(String(stealDel.msg || '')), '自己是房主也删不掉别人的存档', JSON.stringify(stealDel).slice(0, 90));
  A.clear();
  a.send(JSON.stringify({ t: 'saveDelete', id: 'weird1' }));
  await A.wait((m) => m.t === 'saveList');
  ok(!store.getSave('weird1') && !!store.getSave(saveId), 'owner 照样删得掉自己的（weird1 已删，hero 的那份没动）');
  f.close();

  // ---- 管理页导入后，在线连接重新绑到新对象 ----
  {
    const bundleNow = JSON.parse(JSON.stringify(store.exportBundle()));
    bundleNow.accounts.hero.name = '导入改名';
    const impRes = await api('POST', '/admin/import?merge=1', JSON.stringify(bundleNow), 'test-admin-key');
    const impJson = JSON.parse(impRes.body);
    ok(impRes.status === 200 && impJson.sessions && impJson.sessions.rebound >= 1,
      '导入成功后按用户名把在线连接重绑了一遍', impRes.body.replace(/\s+/g, ' ').slice(0, 150));
    ok(!!store.getAccount('hero') && store.getAccount('hero').name === '导入改名', '账号文档确实是新对象');
    A.clear();
    a.send(JSON.stringify({ t: 'profile', name: '导入后又改' }));
    const pf = await A.wait((m) => m.t === 'account' && m.action === 'profile');
    ok(pf.account && pf.account.name === '导入后又改', '在线连接改资料仍然生效');
    await store.flush();
    const nameOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')).accounts.hero.name;
    ok(nameOnDisk === '导入后又改', '写进的是新对象而不是被替换掉的孤儿（磁盘上能看到）', nameOnDisk);
  }

  // ============================================================
  console.log('\n[13] 第三轮 review：锁的原子性 / 写盘期间的改动 / 特殊 map key / 导入的落盘确认');

  // ---- 锁：抢不到就不认领，写不了也不认领，僵死的能接管 ----
  {
    const dirK = tmp('lockown');
    const K1 = new JsonStore(dirK).loadSync();
    ok(K1.acquireLock() === true && K1.lockOwned === true, '第一个实例用 O_EXCL 建锁成功');
    const K2 = new JsonStore(dirK).loadSync();
    ok(K2.acquireLock() === false && K2.lockOwned === false && K2.lockError === 'busy',
      '第二个实例被拒绝，而且不会「顺便」认领这把锁', JSON.stringify([K2.lockOwned, K2.lockError]));
    ok(K1.readLock().id === K1.lockId, '被拒绝的一方不会把别人的锁内容覆盖掉');
    K2.releaseLock();
    ok(fs.existsSync(path.join(dirK, '.lock')), '非持锁者照样删不掉锁');

    const dirRO = tmp('locknowrite');
    fs.mkdirSync(path.join(dirRO, '.lock'));                    // open('wx') / unlink 都会失败
    const K3 = new JsonStore(dirRO).loadSync();
    ok(K3.acquireLock() === false && K3.lockOwned === false && K3.lockError !== 'busy' && !!K3.lockError,
      '锁文件写不出来（只读目录 / 盘满 / 被占）时也不能当成「已持锁」', String(K3.lockError));
    K3.releaseLock();
    ok(fs.existsSync(path.join(dirRO, '.lock')), '而且不会把挡路的东西删掉');

    const dirDead = tmp('lockdead');
    fs.mkdirSync(dirDead, { recursive: true });
    fs.writeFileSync(path.join(dirDead, '.lock'), '99999999 deadbeef\n');
    const K4 = new JsonStore(dirDead).loadSync();
    ok(K4.acquireLock() === true && K4.readLock().id === K4.lockId, '僵死锁（pid 早没了）会被接管');
    K4.releaseLock();
    ok(!fs.existsSync(path.join(dirDead, '.lock')), '接管之后退出照样释放干净');
    for (const d of [dirK, dirRO, dirDead]) fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- flush 途中又改了数据：必须仍然算脏，并写进下一轮 ----
  {
    const dirG = tmp('genflush');
    const sG = new JsonStore(dirG).loadSync();
    sG.closed = true;                                            // 不让后台定时器插一脚
    sG.putAccount({ user: 'racer', pass: 'abcd', name: '第一版' });
    const realWrite = sG.writeText.bind(sG);
    let gate = null;
    sG.writeText = (file, text) => new Promise((resolve) => { gate = () => realWrite(file, text).then(resolve); });
    const pending = sG.flushOnce();
    for (let i = 0; i < 400 && !gate; i++) await new Promise((r) => setTimeout(r, 2));   // 等它走进 await 里
    sG.putAccount({ user: 'racer', pass: 'abcd', name: '第二版' });   // 就卡在这一瞬间改数据
    gate();
    const r = await pending;
    sG.writeText = realWrite;                 // 放行下一轮：恢复成真写
    ok(r.ok && r.wrote.includes('accounts') && sG.dirty.has('accounts'),
      '写完发现「期间还有新改动」→ 脏标记保留，不会把新改动标成已保存', JSON.stringify([r.wrote, [...sG.dirty]]));
    await sG.flushOnce();
    const diskName = JSON.parse(fs.readFileSync(path.join(dirG, 'accounts.json'), 'utf8')).accounts.racer.name;
    ok(diskName === '第二版' && !sG.dirty.has('accounts'), '下一轮把新改动落盘了（重启不会退回第一版）', diskName);
    // 序列化本身要在 await 之前完成：不能把「改了一半的文档」写出去
    sG.putAccount({ user: 'snapshotme', pass: 'abcd', name: 'A' });
    let seen = '';
    sG.writeText = async (file, text) => { seen = text; return realWrite(file, text); };
    await sG.flushOnce();
    sG.putAccount({ user: 'snapshotme', pass: 'abcd', name: 'B' });
    ok(/"name": "A"/.test(seen) && JSON.parse(seen).accounts.snapshotme.name === 'A',
      '落盘用的是写盘那一刻的快照字符串，不是活对象的引用');
    fs.rmSync(dirG, { recursive: true, force: true });
  }

  // ---- __proto__ / constructor 这类 key 进不了任何一张表 ----
  {
    const dirP = tmp('protokey');
    fs.writeFileSync(path.join(dirP, 'saves.json'), JSON.stringify({ v: 1, saves: { ok1: { wave: 2, owners: ['x'], players: [] } } }));
    const sP = new JsonStore(dirP).loadSync();
    ok(sP.getSave('constructor') === null && sP.getSave('toString') === null && sP.getSave('hasOwnProperty') === null,
      '按 id 取存档不会顺着原型链拿到方法（getSave("constructor") 不返回函数）');
    const made = sP.putSave({ id: '__proto__', wave: 3, owners: ['x'], players: [] });
    ok(made.id !== '__proto__' && safeId(made.id), 'putSave 收到特殊 id 会自动换发合法的', made.id);
    ok(sP.saveCount() === 2 && Object.getPrototypeOf(sP.savesDoc.saves) === Object.prototype, 'map 的原型没被动过');
    sP.deleteSave('constructor');
    ok(sP.saveCount() === 2, 'deleteSave("constructor") 不会把别人的东西删掉');

    const dirQ = tmp('protoimp');
    const sQ = new JsonStore(dirQ).loadSync();
    const weirdAcc = {};
    Object.defineProperty(weirdAcc, '__proto__', { value: { user: '__proto__', pass: 'abcd' }, enumerable: true, writable: true, configurable: true });
    const imp = sQ.importBundle({
      kind: 'potato-brawl-backup', v: 1, accounts: weirdAcc,
      saves: [{ id: '__proto__', wave: 1, players: [] }, { id: 'k1', wave: 1, players: [] }],
    }, { merge: true });
    ok(imp.accounts === 0 && imp.saves === 1 && imp.skipped === 2, '导入时特殊 key 一律跳过并计入 skipped', JSON.stringify(imp));
    ok(sQ.accountCount() === 0 && sQ.saveCount() === 1 && ({}).wave === undefined && ({}).pass === undefined,
      '没有污染原型，也没有凭空多出可用记录', JSON.stringify([sQ.accountCount(), sQ.saveCount()]));
    const accQ = new AccountService(sQ);
    ok(/内部属性重名/.test(accQ.register({ user: '__proto__', pass: 'abcd', name: 'x' }).error || ''),
      '这种用户名直接不让注册（而不是「注册成功、重启后凭空消失」）');
    await sQ.close();
    fs.rmSync(dirP, { recursive: true, force: true });
    fs.rmSync(dirQ, { recursive: true, force: true });
  }

  // ---- 管理页导入：落盘失败就不能说成功 ----
  {
    const accFile = path.join(dataDir, 'accounts.json');
    const bak = fs.readFileSync(accFile, 'utf8');
    fs.rmSync(accFile);
    fs.mkdirSync(accFile);                              // rename 到目录上必失败
    const bundle = JSON.parse(JSON.stringify(store.exportBundle()));
    bundle.accounts.proto_probe = { user: 'proto_probe', pass: 'abcd', name: '探针', session: '', prefs: {}, stats: {}, saves: [] };
    const bad = await api('POST', '/admin/import?merge=1', JSON.stringify(bundle), 'test-admin-key');
    const badJson = JSON.parse(bad.body);
    ok(bad.status === 500 && badJson.ok === false && badJson.writtenToDisk === false && /没能写进磁盘/.test(badJson.error),
      '写盘失败 → 500 + writtenToDisk:false（不再回 200 说「还原完成」）', `${bad.status} ${bad.body.replace(/\s+/g, ' ').slice(0, 110)}`);
    ok(!!store.getAccount('proto_probe') && (badJson.imported && badJson.imported.accounts >= 1),
      '但内存里确实导入了（错误信息说清「只在内存、重启会退回旧数据」）');
    fs.rmdirSync(accFile);
    fs.writeFileSync(accFile, bak);                     // 清障，并把原文件放回原位（内容随后会被 flush 覆盖）
    const fix = await api('POST', '/admin/flush', '', 'test-admin-key');
    ok(fix.status === 200 && JSON.parse(fix.body).ok === true, '障碍清掉后「强制落盘」成功', fix.body.replace(/\s+/g, ' ').slice(0, 90));
    ok(!!JSON.parse(fs.readFileSync(accFile, 'utf8')).accounts.proto_probe, '这时候盘上才是导入后的数据');
    const okImport = await api('POST', '/admin/import?merge=1', JSON.stringify(bundle), 'test-admin-key');
    ok(okImport.status === 200 && JSON.parse(okImport.body).writtenToDisk === true, '正常导入仍然 200 且明确写盘成功', okImport.body.replace(/\s+/g, ' ').slice(0, 90));
  }

  a.close();
  await store.flush();   // 关服前把没落盘的改动写完，测试才敢直接读文件
} finally {
  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
