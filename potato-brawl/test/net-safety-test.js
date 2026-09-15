// 联机层的健壮性 / 安全性回归测试
//   node test/net-safety-test.js
//
// 覆盖 Qodo review 提出的这几类问题（每条都有断言，别再退回去）：
//   [1] 聊天/名字里的 HTML（服务端清洗 + 设置白名单）
//   [2] 房主用设置项打死服务器（difficulty 巨大、levelId: __proto__）
//   [3] 房间数无上限、房间删除后残留成员记录
//   [4] 明确退出的玩家留在模拟里 / 掉线占名额 / 重连后 connected 没恢复 / 双房主
//   [5] 快照事件只发给第一个人（Game.snapshot 会清空 events）
//   [6] 静态目录穿越（/client/../server/index.js）与非法 URI 让进程挂掉
//   [7] 中途加入的人收不到 start，永远卡在客厅
// 不需要浏览器，也不依赖外部网络。
import http from 'node:http';
import path from 'node:path';
import { cleanSettings, cleanText, Room } from '../server/src/rooms/room.js';
import { MAX_ROOMS, RoomManager } from '../server/src/rooms/roomManager.js';
import { createServer } from '../server/src/net/server.js';
import { DEFAULT_SETTINGS, MODE, SNAPSHOT_EVERY, TICK_DT } from '../shared/constants.js';
import { LEVELS } from '../shared/level.js';
import { moveAndCollide } from '../shared/physics.js';
import WebSocket from 'ws';
import os2 from 'node:os';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ' — ' + extra : ''}`); }
};
const hasTag = (s) => /[<>]/.test(String(s));

// ---------------------------------------------------------------- 1. 文本清洗 / 设置白名单
{
  console.log('\n[1] 文本清洗与设置校验');
  ok(cleanText('<img src=x onerror=alert(1)>hi') === 'hi', '整段标签被删掉，内容保留', JSON.stringify(cleanText('<img src=x onerror=alert(1)>hi')));
  ok(cleanText('a<b>c') === 'ac', '落单的尖括号也被剥掉', JSON.stringify(cleanText('a<b>c')));
  ok(cleanText('a'.repeat(500)).length === 160, '聊天长度被截断');
  const ctrl = cleanText('上\u0000中\u001b[31m下');
  ok(!/[\u0000-\u001f\u007f]/.test(ctrl), '控制字符被去掉', JSON.stringify(ctrl));

  const evil = cleanSettings({
    difficulty: 1e9, levelId: '__proto__', mode: '<script>', maxPlayers: 9999,
    totalWaves: 'abc', timeLimit: -1, constructor: 'x', __proto__: 'y',
  }, { ...DEFAULT_SETTINGS });
  ok(evil.difficulty === 3, 'difficulty 被夹到上限（原来会把刷怪预算乘爆，服务器卡死）', String(evil.difficulty));
  ok(evil.levelId === DEFAULT_SETTINGS.levelId, 'levelId 不在 LEVELS 里 → 丢弃（原来 __proto__ 会取到 Object.prototype）', String(evil.levelId));
  ok(MODE[evil.mode.toUpperCase().replace('PVE', 'PVE')] || ['pve', 'ffa', 'team'].includes(evil.mode), 'mode 只能是 pve/ffa/team', String(evil.mode));
  ok(evil.maxPlayers <= 8 && evil.maxPlayers >= 1, 'maxPlayers 在 1..8', String(evil.maxPlayers));
  ok(evil.totalWaves === DEFAULT_SETTINGS.totalWaves, '非数字的 totalWaves 被忽略', String(evil.totalWaves));
  ok(evil.timeLimit >= 30, 'timeLimit 下限保护', String(evil.timeLimit));
  ok(Object.getPrototypeOf(evil) === Object.prototype && evil.constructor === Object, '没被 constructor/__proto__ 污染');

  // 正常客户端发来的值必须原样通过，别把玩法改坏
  const legit = cleanSettings({ mode: 'team', levelId: 'cellar', difficulty: 1.8, totalWaves: 30, prepTime: 35, scoreLimit: 30, timeLimit: 600, maxPlayers: 6 }, { ...DEFAULT_SETTINGS });
  ok(legit.mode === 'team' && legit.levelId === 'cellar' && legit.difficulty === 1.8 && legit.totalWaves === 30
    && legit.prepTime === 35 && legit.scoreLimit === 30 && legit.timeLimit === 600 && legit.maxPlayers === 6,
    '合法设置原样保留', JSON.stringify(legit));
  ok(Object.keys(LEVELS).includes(legit.levelId), 'levelId 白名单来自 LEVELS');
}

// ---------------------------------------------------------------- 2. 房间数上限 / 残留记录
{
  console.log('\n[2] 房间管理');
  const m = new RoomManager();
  let made = 0;
  while (m.createRoom({ name: '房间' + made, hostName: '房主' })) made++;
  ok(made === MAX_ROOMS, `第 ${MAX_ROOMS} 个之后 createRoom 返回 null（不再无限建房间）`, `实际建了 ${made}`);
  ok(m.createRoom({ name: '再来一个' }) === null, '超上限后拒绝创建');
  // 房间删掉时，指向它的成员记录要一起清掉
  const codes = [...m.rooms.keys()];
  m.removeRoom(codes[0]);
  ok(m.rooms.size === MAX_ROOMS - 1, 'removeRoom 生效');
  for (const c of codes.slice(1)) m.removeRoom(c);
  ok(m.rooms.size === 0 && m.players.size === 0, '房间清空后不留孤儿成员记录', `players=${m.players.size}`);
}

// ---------------------------------------------------------------- 3. 成员生命周期 / 快照广播
function stubSock(box) {
  return { readyState: 1, send(s) { try { box.push(JSON.parse(s)); } catch { box.push(s); } }, close() {}, ping() {}, on() {} };
}
function fakeManager() {
  return { rooms: new Map(), players: new Map(), removeRoom() {}, broadcastRoomList() {} };
}
{
  console.log('\n[3] 离开 / 掉线 / 重连 / 快照');
  const room = new Room(fakeManager(), 'TEST1', { name: '测试房' });
  const boxA = [], boxB = [];
  const pa = room.addPlayer(stubSock(boxA), { id: 'pa', name: '阿A', token: 'ta' });
  const pb = room.addPlayer(stubSock(boxB), { id: 'pb', name: '阿B', token: 'tb' });
  pa.host = true; pa.ready = true; pb.ready = true;
  room.start();
  ok(room.game && room.game.players.size === 2, '开局：对局里有 2 名玩家');

  // 明确退出：必须从模拟里摘掉（原来只标 connected=false，会继续被 AI 当靶子）
  room.removePlayer('pb', { drop: true });
  ok(!room.players.has('pb'), '退出后不在房间成员里');
  ok(!room.game.players.has('pb'), '退出后也不在对局模拟里（不再当活靶子）');

  // 快照事件：每个人都得拿到（原来 g.snapshot(p.id) 逐人调用，第一个人就把 events 清了）
  const room2 = new Room(fakeManager(), 'TEST2', { name: '测试房2' });
  const b1 = [], b2 = [];
  const q1 = room2.addPlayer(stubSock(b1), { id: 'q1', name: '甲', token: 't1' });
  room2.addPlayer(stubSock(b2), { id: 'q2', name: '乙', token: 't2' });
  q1.ready = true; room2.players.get('q2').ready = true;
  room2.start();
  room2.tickCount = SNAPSHOT_EVERY - 1;
  room2.game.addEvent({ t: 'jump', x: 10, y: 20 });
  room2.game.addEvent({ t: 'edouble', x: 11, y: 21 });
  room2.tick(TICK_DT);
  const snap1 = b1.filter((m) => m.t === 'snap').pop();
  const snap2 = b2.filter((m) => m.t === 'snap').pop();
  ok(snap1 && snap2, '两人都收到快照');
  ok(snap1.ev.some((e) => e.t === 'jump') && snap2.ev.some((e) => e.t === 'jump'),
    '同一条事件广播给了每个人（跳台扬尘不再只发给第一个人）', `ev1=${JSON.stringify(snap1.ev)} ev2=${JSON.stringify(snap2.ev)}`);
  ok(snap2.ev.some((e) => e.t === 'edouble'), '第二个人也拿到了 edouble');
  ok(!room2.game.events.some((ev) => ev.t === 'jump' || ev.t === 'edouble'), '这批事件被快照消费掉了（不会堆着或重复下发）', JSON.stringify(room2.game.events.map((e) => e.t)));

  // 掉线 → 重连：对局里的 connected 要恢复，否则合作模式会误判团灭
  const q2 = room2.players.get('q2');
  q2.connected = false;
  room2.removePlayer('q2', { drop: false });
  ok(room2.game.players.get('q2').connected === false, '掉线时对局里标成未连接');
  room2.game.players.get('q2').alive = false;         // 模拟他倒地状态被队友接着打的场景
  room2.reconnect('q2', stubSock([]));
  ok(room2.players.get('q2').connected && room2.game.players.get('q2').connected,
    '重连后网络侧和对局侧都恢复 connected（不会下一秒被判团灭）');

  // 房主标记：永久移除才移交，且不移交给「离线还挂着的房主」之外的人
  const room3 = new Room(fakeManager(), 'TEST3', { name: '测试房3' });
  const h = room3.addPlayer(stubSock([]), { id: 'h', name: '房主', token: 'th' });
  const g1 = room3.addPlayer(stubSock([]), { id: 'g1', name: '组员', token: 'tg' });
  h.host = true;
  room3.removePlayer('h', { drop: true });
  ok(g1.host === true, '房主真的走了 → 移交给下一个成员');
  const room4 = new Room(fakeManager(), 'TEST4', { name: '测试房4' });
  const h4 = room4.addPlayer(stubSock([]), { id: 'h4', name: '房主', token: 'th' });
  room4.addPlayer(stubSock([]), { id: 'g4', name: '组员', token: 'tg' });
  h4.host = true;
  room4.removePlayer('h4', { drop: false });            // 只是掉线
  ok(h4.host === true && room4.players.get('g4').host !== true, '仅掉线不转交房主（60 秒内回来还是他的房）');
  room4.removePlayer('h4', { drop: true });
  ok(h4.host === false && room4.players.get('g4').host === true, '永久移除后清掉原房主标记再移交（不会双房主）');

  // 聊天走一遍房间：广播出去的文本不能带标签
  const boxC = [];
  const room5 = new Room(fakeManager(), 'TEST5', { name: '测试房5' });
  const c1 = room5.addPlayer(stubSock(boxC), { id: 'c1', name: 'C', token: 'tc' });
  c1.host = true;
  room5.handle(c1, { t: 'chat', text: '<img src=x onerror=alert(1)>晚上开黑' });
  const chat = boxC.filter((m) => m.t === 'chat').pop();
  ok(chat && !hasTag(chat.text) && chat.text.includes('晚上开黑'), '广播出去的聊天没有标签字符', JSON.stringify(chat && chat.text));

  // 非法设置不能把对局带崩
  room5.handle(c1, { t: 'settings', settings: { difficulty: 1e12, levelId: '__proto__' } });
  const room6 = new Room(fakeManager(), 'TEST6', { name: '测试房6' });
  const d1 = room6.addPlayer(stubSock([]), { id: 'd1', name: 'D', token: 'td' });
  d1.host = true; d1.ready = true;
  room6.settings = cleanSettings({ difficulty: 1e12, levelId: '__proto__', totalWaves: 9999 }, room6.settings);
  room6.start();
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) room6.tick(TICK_DT);
  ok(Date.now() - t0 < 3000 && room6.game.tick === 60, '被夹过的设置照样能正常开局跑 60 tick（不卡死）', `${Date.now() - t0}ms`);
}

// ---------------------------------------------------------------- 4. 物理：ledge 与动量（我自己的改动）
{
  console.log('\n[4] 跳台物理：贴边起跳不被判成撞墙');
  const plat = { x: 100, y: 200, w: 100, h: 22 };
  const body = { x: 100 - 20, y: 210, w: 20, h: 30, vx: 90, vy: -600 };   // 紧贴平台左侧、正在上升
  const res = moveAndCollide(body, 1, -8, [plat], plat);
  ok(res.climb === true, '贴到平台边缘时标记 climb（敌人侧的「扒上边缘」才有机会跑）');
  ok(res.hitX === false, '贴边不算撞墙（不会被 blockedT/清零逻辑接管）');
  ok(body.vx === 90, '贴边那一下不清 vx（翻上边缘要靠这个速度）', String(body.vx));

  const wall = { x: 100, y: 0, w: 20, h: 400 };
  const b2 = { x: 118, y: 200, w: 20, h: 30, vx: -90, vy: 0 };
  const r2 = moveAndCollide(b2, -6, 0, [wall], null);
  ok(r2.hitX === true && b2.vx === 0, '真的撞墙仍然按原语义清零 vx（动量由调用方用碰撞前的值保留）');

  const b3 = { x: 118, y: 200, w: 20, h: 30, vx: -90, vy: 0 };
  const r3 = moveAndCollide(b3, -6, 0, [wall], plat);      // plat 不是这块墙
  ok(r3.hitX === true && r3.climb === false, 'ledge 只对自己那块平台生效');
}

// ---------------------------------------------------------------- 5~7. 起一个真服务器端到端验
// 每个连接挂一个常驻监听把消息收进数组，再按条件等：
// 用 ws.once('message') 轮流等消息会因为「等超时的那个 handler 还在」而吃掉后面的包，测试会抽。
function track(ws) {
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred(m)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(m);
      }
    }
  });
  return {
    msgs,
    wait(pred, timeout = 4000) {
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
const got = (m) => (m && m.__miss ? '没等到（收到：' + m.got + '）' : '');

function httpGet(port, rawPath) {
  return new Promise((resolve) => {
    const req = http.get({ port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.code) }));
  });
}
import fs2 from 'node:fs';
const SAFETY_DATA_DIR = fs2.mkdtempSync(path.join(os2.tmpdir(), 'pb-safety-'));
// 这个测试针对文本清洗 / 设置白名单 / 静态服务，不测登录，所以把 requireLogin 关掉
const { server, manager, stop } = createServer({ dataDir: SAFETY_DATA_DIR, requireLogin: false });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

try {
  console.log('\n[5] 静态服务：目录穿越 / 非法 URI');
  const okIndex = await httpGet(port, '/');
  ok(okIndex.status === 200 && okIndex.body.includes('<canvas'), '首页可访问', String(okIndex.status));
  const okJs = await httpGet(port, '/shared/physics.js');
  ok(okJs.status === 200 && okJs.body.includes('moveAndCollide'), 'shared/ 下的模块照常可取');
  const bad1 = await httpGet(port, '/client/../server/index.js');
  ok(bad1.status !== 200, '/client/../server/index.js 不再被吐出来', `${bad1.status} ${bad1.body.slice(0, 40)}`);
  const bad2 = await httpGet(port, '/shared/../server/src/game/game.js');
  ok(bad2.status !== 200, '/shared/../server/… 也被挡住', String(bad2.status));
  const bad3 = await httpGet(port, '/..%2f..%2fetc%2fpasswd');
  ok(bad3.status !== 200, '编码过的穿越也不行', String(bad3.status));
  const bad4 = await httpGet(port, '/%E4%A0%80%/x.js');
  ok(bad4.status === 400 || bad4.status === 404, '非法百分号转义 → 4xx 而不是崩进程', String(bad4.status));
  const bad5 = await httpGet(port, '/package.json');
  ok(bad5.status !== 200, '项目根的 package.json 不在可服务目录里', String(bad5.status));
  const alive = await httpGet(port, '/');
  ok(alive.status === 200, '发了畸形请求之后服务器还活着');

  console.log('\n[6] 聊天与房间列表：拿不到可执行内容');
  const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const A = track(a);
  await new Promise((r) => a.once('open', r));
  a.send(JSON.stringify({ t: 'hello', name: '阿A', token: 'tokA' }));
  const welcomeA = await A.wait((m) => m.t === 'welcome');
  ok(!welcomeA.__miss, 'A 完成握手', got(welcomeA));
  a.send(JSON.stringify({ t: 'create', roomName: '<b>bold</b>房间', name: '<i>A</i>' }));
  const joinedA = await A.wait((m) => m.t === 'joined');
  ok(!joinedA.__miss, 'A 建房成功', got(joinedA));
  const code = joinedA.code;
  const roomRow = manager.getRoom(code);
  ok(roomRow && roomRow.name === 'bold房间', '房间名被清洗后入库', JSON.stringify(roomRow && roomRow.name));
  a.send(JSON.stringify({ t: 'chat', text: '<img src=x onerror=window.__pwned=1>看这里' }));
  const chatA = await A.wait((m) => m.t === 'chat');
  ok(!chatA.__miss && !hasTag(chatA.text) && !/[&"']/.test(chatA.text), '聊天回声里没有标签/引号/实体', JSON.stringify(chatA.text || chatA));
  const roomMsg = await A.wait((m) => m.t === 'room' && m.room.players.some((p) => p.host));
  ok(!roomMsg.__miss && roomMsg.room.name === 'bold房间' && roomMsg.room.players.every((p) => !hasTag(p.name)),
    '房间状态里的名字也是干净的（前端拼 innerHTML 只能用这个）', JSON.stringify(roomMsg.room && [roomMsg.room.name, roomMsg.room.players.map((p) => p.name)]));

  console.log('\n[7] 中途加入的人能直接进对局');
  a.send(JSON.stringify({ t: 'ready', v: true }));
  await A.wait((m) => m.t === 'room' && m.room.players[0].ready);
  a.send(JSON.stringify({ t: 'start' }));
  const startA = await A.wait((m) => m.t === 'start');
  ok(!startA.__miss, 'A 开局拿到 start', got(startA));
  await new Promise((r) => setTimeout(r, 400));              // 让对局真的跑起来
  const b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const B = track(b);
  await new Promise((r) => b.once('open', r));
  b.send(JSON.stringify({ t: 'hello', name: '阿B', token: 'tokB' }));
  const welcomeB = await B.wait((m) => m.t === 'welcome');
  ok(!welcomeB.__miss, 'B 完成握手', got(welcomeB));
  b.send(JSON.stringify({ t: 'join', code, name: '阿B' }));
  const joinedB = await B.wait((m) => m.t === 'joined');
  ok(!joinedB.__miss, 'B 中途加入成功', got(joinedB));
  const startB = await B.wait((m) => m.t === 'start');
  ok(!startB.__miss, 'B 立刻收到 start（原来只发 joined，客户端会一直卡在客厅丢快照）', got(startB));
  const snapB = await B.wait((m) => m.t === 'snap' && m.me);
  ok(!snapB.__miss, 'B 拿到带自己状态的快照', got(snapB));
  const snapA = await A.wait((m) => m.t === 'snap');
  ok(!snapA.__miss, 'A 也还在收快照');
  ok(startB.mode === startA.mode && startB.levelId === startA.levelId, 'B 看到的模式/地图与房间一致', `${startB.mode}/${startB.levelId}`);
  const nowRoom = manager.getRoom(code);
  ok(nowRoom && nowRoom.game && nowRoom.game.players.has(welcomeB.id), 'B 在对局模拟里有了自己的实体');

  console.log('\n[8] 掉线不占名额');
  const liveRoom = manager.getRoom(code);
  const before = liveRoom ? liveRoom.players.size : 0;
  const bId = welcomeB && welcomeB.id;

  b.close();
  await new Promise((r) => setTimeout(r, 400));
  const r2 = manager.getRoom(code);
  const gone = r2 ? [...r2.players.values()].filter((p) => !p.connected) : [];
  ok(r2 && r2.players.size === before && gone.length === 1, '掉线者先进入「可重连」状态：60 秒宽限期内还占位（这是设计），房间没被误删', `size=${r2 && r2.players.size}/${before} 掉线=${gone.length}`);
  ok(gone.every((p) => !p.ws || p.ws.readyState !== 1), '掉线玩家的 socket 引用被摘掉，广播不再往死连接上写', JSON.stringify(gone.map((p) => p.ws && p.ws.readyState)));
  const recGone = !manager.players.has(bId);
  ok(recGone, 'manager 侧的连接记录随关闭清掉（定时器随后走 room.removePlayer 释放名额）');
  a.close();
} finally {
  await stop();
  try { server.close(); } catch { /* ignore */ }
  fs2.rmSync(SAFETY_DATA_DIR, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
