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

const { server, manager } = createServer();

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

process.on('SIGINT', () => {
  console.log('\n  服务端已停止，再见！');
  process.exit(0);
});

// 控制台状态
if (process.env.VERBOSE) {
  setInterval(() => {
    const s = manager.stats();
    console.log(`[状态] 房间 ${s.rooms} · 玩家 ${s.players}`);
  }, 10000);
}
