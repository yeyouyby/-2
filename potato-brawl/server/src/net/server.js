// HTTP 静态服务 + WebSocket 网关
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, MAX_ROOMS } from '../rooms/roomManager.js';
import { cleanText, send } from '../rooms/room.js';
import { TICK_DT } from '../../../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const CLIENT_DIR = path.join(ROOT, 'client');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

function newId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}
function newToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function safeName(n) {
  // 名字会被拼进客户端的 innerHTML（房间列表、玩家列表、计分板），这里先把标签字符剥掉，
  // 前端另有一层转义
  return cleanText(n, 14) || '土豆';
}

/** 开局信息：中途加入 / 断线重连的人也需要它才知道地图和模式，否则会卡在客厅 */
function sendStart(ws, room) {
  if (!room.game) return;
  send(ws, {
    t: 'start',
    mode: room.settings.mode,
    levelId: room.settings.levelId,
    seed: room.seed,
    settings: room.game.settings,
    myIds: Object.fromEntries([...room.players.values()].map((p) => [p.id, p.id])),
  });
}

export function createServer() {
  const manager = new RoomManager();

  const send404 = (res, why) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found' + (why ? ': ' + why : ''));
  };

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      // 非法百分号转义（/%%/）会让 decodeURIComponent 抛异常，不能让它把进程带下水
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    if (!urlPath || urlPath === '/') urlPath = '/index.html';
    if (urlPath.includes('\0')) { res.writeHead(400).end('bad request'); return; }

    // 只服务 client/ 和 shared/ 两个目录。原来只校验「还在项目根里」，
    // 于是 /client/../server/index.js 能把服务端源码拖下来。
    const base = urlPath.startsWith('/shared/') ? SHARED_DIR : CLIENT_DIR;
    const rel = urlPath.startsWith('/shared/') ? urlPath.slice(8)
      : urlPath.startsWith('/client/') ? urlPath.slice(8) : urlPath;
    const file = path.join(base, path.normalize('/' + rel).replace(/^[/\\]+/, ''));
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext]) { send404(res, urlPath); return; }     // 未知后缀一概不给
    fs.readFile(file, (err, data) => {
      if (err) { send404(res, urlPath); return; }
      res.writeHead(200, {
        'Content-Type': MIME[ext],
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let joined = false;
    const helloTimeout = setTimeout(() => { if (!joined) try { ws.close(); } catch { /* ignore */ } }, 15000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;

      // ---- 握手 ----
      if (msg.t === 'hello') {
        if (ws.pid) return;
        const name = safeName(msg.name);
        const token = msg.token || newToken();
        const id = newId();
        ws.pid = id;
        ws.token = token;
        ws.name = name;
        joined = true;
        clearTimeout(helloTimeout);

        // 断线重连：token 匹配且该玩家在房间里处于掉线状态
        let reconnected = null;
        if (msg.token) {
          for (const room of manager.rooms.values()) {
            for (const p of room.players.values()) {
              if (p.token === msg.token && !p.connected) {
                // 保留原 id；房间侧负责把网络成员和对局里的玩家一起标回 connected
                room.reconnect(p.id, ws);
                ws.pid = p.id;
                manager.players.set(p.id, { roomCode: room.code, id: p.id });
                reconnected = { room, np: p };
                break;
              }
            }
            if (reconnected) break;
          }
        }

        send(ws, { t: 'welcome', id: ws.pid, token, name });
        if (reconnected) {
          const { room, np } = reconnected;
          room.chat_('系统', `${np.name} 重新连接成功`, true);
          room.broadcastRoom();
          send(ws, { t: 'room', room: room.state() });
          sendStart(ws, room);
        } else {
          manager.addLobbySocket(ws);
          send(ws, { t: 'rooms', rooms: manager.roomList() });
        }
        return;
      }

      if (!ws.pid) return;
      const rec = manager.players.get(ws.pid);
      const room = rec ? manager.getRoom(rec.roomCode) : null;
      const np = room ? room.players.get(ws.pid) : null;

      switch (msg.t) {
        case 'create': {
          if (rec) manager.leaveRoom(ws.pid);            // 已经在别的房间 → 先退掉，别留个幽灵成员占名额
          manager.removeLobbySocket(ws);
          const r = manager.createRoom({ name: safeName(msg.roomName) || '土豆房间', hostName: safeName(msg.name || ws.name) });
          if (!r) {
            send(ws, { t: 'err', msg: `服务器房间数已满（上限 ${MAX_ROOMS}），先加入现成的房间吧` });
            manager.addLobbySocket(ws);
            return;
          }
          const res = manager.joinRoom(r.code, ws, { id: ws.pid, name: safeName(msg.name || ws.name), token: ws.token });
          if (res.error) { send(ws, { t: 'err', msg: res.error }); manager.addLobbySocket(ws); return; }
          send(ws, { t: 'joined', code: r.code });
          break;
        }
        case 'join': {
          const want = manager.getRoom(msg.code);
          if (rec && want && rec.roomCode !== want.code) manager.leaveRoom(ws.pid);   // 换房间：先从旧房间摘出来
          manager.removeLobbySocket(ws);
          const res = manager.joinRoom(msg.code, ws, { id: ws.pid, name: safeName(msg.name || ws.name), token: ws.token });
          if (res.error) { send(ws, { t: 'err', msg: res.error }); manager.addLobbySocket(ws); return; }
          send(ws, { t: 'joined', code: res.room.code });
          sendStart(ws, res.room);      // 对局中进来的人：没有 start 客户端就不激活，只会一直丢快照
          break;
        }
        case 'leave': {
          manager.leaveRoom(ws.pid);
          manager.addLobbySocket(ws);
          send(ws, { t: 'rooms', rooms: manager.roomList() });
          break;
        }
        case 'input': {
          if (!np || !room) return;
          const now = Date.now();
          if (now - (np.lastInputAt || 0) < 6) return; // 简单的输入限速
          np.lastInputAt = now;
          room.handle(np, msg);
          break;
        }
        default:
          if (np && room) room.handle(np, msg);
          else send(ws, { t: 'err', msg: '你还没有加入房间' });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      manager.removeLobbySocket(ws);
      if (ws.pid) {
        const rec = manager.players.get(ws.pid);
        const room = rec ? manager.getRoom(rec.roomCode) : null;
        if (room) {
          const np = room.players.get(ws.pid);
          // 保留 60 秒重连窗口
          if (np) {
            np.connected = false;
            room.removePlayer(ws.pid, { drop: false });
            if (np.ws === ws) np.ws = null;               // 别再往死 socket 上写
            room.chat_('系统', `${np.name} 掉线了（60 秒内可重连）`, true);
            room.broadcastRoom();
            const pid = ws.pid;
            setTimeout(() => {
              const cur = room.players.get(pid);
              if (!cur || cur.connected) return;
              // 注意：manager 的记录在连接关闭时已经删了，只调 manager.leaveRoom 会直接 return，
              // 掉线的人会永远留在 room.players 里占名额、房间也一直不空。所以这里分两种情况处理。
              if (manager.players.has(pid)) manager.leaveRoom(pid);
              else room.removePlayer(pid, { drop: true });
            }, 60000);
          }
        }
        manager.players.delete(ws.pid);
      }
    });

    ws.on('error', () => { /* ignore */ });
  });

  // 心跳
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 15000);

  // 主循环：60Hz 定步长
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    if (acc > 0.5) acc = 0.5; // 防止卡顿后追帧雪崩
    let guard = 0;
    while (acc >= TICK_DT && guard++ < 10) {
      manager.tickAll(TICK_DT);
      acc -= TICK_DT;
    }
  }, 4);

  return { server, wss, manager, stop() { clearInterval(hb); clearInterval(loop); } };
}
