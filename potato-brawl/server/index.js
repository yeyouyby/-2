#!/usr/bin/env node
// 《土豆兄弟·横版》局域网联机服务端入口
import os from 'node:os';
import { createServer } from './src/net/server.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = parseInt(arg('port', process.env.PORT || '3000'), 10);
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const DATA_DIR = process.argv.includes('--no-data') ? false : arg('data-dir', process.env.PB_DATA_DIR || undefined);
const ADMIN_KEY = arg('admin-key', process.env.PB_ADMIN_KEY || '');
const REQUIRE_LOGIN = !process.argv.includes('--no-login');

const { server, manager, store, adminKey } = createServer({
  dataDir: DATA_DIR, adminKey: ADMIN_KEY, requireLogin: REQUIRE_LOGIN,
});

if (store && !store.acquireLock()) {
  console.warn('\n  ⚠️  data/.lock 被另一个进程占着，那个进程可能也在写同一批存档；继续启动，但请确认没同时开两个服务器。\n');
}

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('');
  console.log('  🥔  《土豆兄弟·横版》Potato Brawl —— 局域网联机服务端');
  console.log('  --------------------------------------------------------');
  console.log(`  本机访问：   http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  局域网访问： http://${a}:${PORT}      ← 把这个发给基友`);
  console.log('  --------------------------------------------------------');
  if (store) {
    console.log(`  账号/存档：  ${store.dir}`);
    console.log(`  数据是明文 JSON（账号、密码、存档都可读），别把这个目录共享出去。`);
    console.log(`  登录要求：   ${REQUIRE_LOGIN ? '开（要注册/登录才能建房进房；--no-login 可关）' : '关（--no-login）'}`);
    console.log(`  数据管理：   http://localhost:${PORT}/admin   口令：${adminKey}`);
    console.log(`  命令行备份： npm run backup  /  npm run restore -- <备份文件>`);
  } else {
    console.log('  账号/存档：  已关闭（--no-data），只当纯联机房间用');
  }
  console.log('  --------------------------------------------------------');
  console.log('  操作：WASD/方向键 移动，空格 跳（可二段），Shift 冲刺，');
  console.log('        E/左Ctrl 救人，1/2/3 选升级，Tab 计分板，Enter 聊天');
  console.log('  提示：需要先创建房间，其他人输入 4 位房间码加入。');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ❌ 端口 ${PORT} 已被占用，换一个：node server/index.js --port 3001\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\n  收到 ${sig}，正在把账号/存档写盘…`);
  try {
    if (store) await store.close();        // close() 里已经 flush + 释放锁
  } catch (e) {
    console.error('  落盘失败：', e && e.message);
  }
  console.log('  服务端已停止，再见！');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 控制台状态
if (process.env.VERBOSE) {
  setInterval(() => {
    const s = manager.stats();
    const extra = store ? ` · 账号 ${store.accountCount()} · 存档 ${store.saveCount()}` : '';
    console.log(`[状态] 房间 ${s.rooms} · 玩家 ${s.players}${extra}`);
  }, 10000);
}
