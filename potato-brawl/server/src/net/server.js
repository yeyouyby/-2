// HTTP 静态服务 + WebSocket 网关
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from '../rooms/roomManager.js';
import { send } from '../rooms/room.js';
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
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 14);
  return s || '土豆';
}

export function createServer() {
  const manager = new RoomManager();

  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    let file;
    if (urlPath.startsWith('/shared/')) file = path.join(SHARED_DIR, urlPath.slice(8));
    else if (urlPath.startsWith('/client/')) file = path.join(CLIENT_DIR, urlPath.slice(8));
    else file = path.join(CLIENT_DIR, urlPath);

    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + urlPath);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
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
                p.ws = ws; p.connected = true; p.id = p.id; // 保留原 id
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
          if (room.game) {
            send(ws, {
              t: 'start', mode: room.settings.mode, levelId: room.settings.levelId,
              seed: room.seed, settings: room.game.settings, myIds: {},
            });
          }
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
          manager.removeLobbySocket(ws);
          const r = manager.createRoom({ name: safeName(msg.roomName) || '土豆房间', hostName: safeName(msg.name || ws.name) });
          const res = manager.joinRoom(r.code, ws, { id: ws.pid, name: safeName(msg.name || ws.name), token: ws.token });
          if (res.error) { send(ws, { t: 'err', msg: res.error }); return; }
          send(ws, { t: 'joined', code: r.code });
          break;
        }
        case 'join': {
          manager.removeLobbySocket(ws);
          const res = manager.joinRoom(msg.code, ws, { id: ws.pid, name: safeName(msg.name || ws.name), token: ws.token });
          if (res.error) { send(ws, { t: 'err', msg: res.error }); manager.addLobbySocket(ws); return; }
          send(ws, { t: 'joined', code: res.room.code });
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
            room.chat_('系统', `${np.name} 掉线了（60 秒内可重连）`, true);
            room.broadcastRoom();
            setTimeout(() => {
              const cur = room.players.get(ws.pid);
              if (cur && !cur.connected) {
                manager.leaveRoom(ws.pid);
              }
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
