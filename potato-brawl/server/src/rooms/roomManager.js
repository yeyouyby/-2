// 房间管理：创建 / 加入 / 列表 / 清理
import { MAX_PLAYERS } from '../../../shared/constants.js';
import { Room, makeCode, send } from './room.js';

// 单进程房间上限：没这个的话，一个客户端一直点「创建房间」就能把内存、
// 以及每次 broadcastRoomList 的体积一起撑爆（房间列表会发给所有连接）。
export const MAX_ROOMS = 64;

export class RoomManager {
  /** opts.store / opts.accounts：明文 JSON 存储与账号服务，Room 通过 manager 拿到 */
  constructor(opts = {}) {
    this.rooms = new Map(); // code -> Room
    this.players = new Map(); // wsId -> {roomCode, id}
    this.lobbySockets = new Set(); // 在大厅（未加入房间）的连接
    this.store = opts.store || null;
    this.accounts = opts.accounts || null;
  }

  createRoom(opts) {
    if (this.rooms.size >= MAX_ROOMS) return null;      // 满了就别再建，调用方负责报错
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room = new Room(this, code, opts);
    this.rooms.set(code, room);
    this.broadcastRoomList();
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  removeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    // 房间没了就把指向它的成员记录一起删掉，否则这些 socket 会一直往死房间里发消息
    for (const id of room.players.keys()) this.players.delete(id);
    this.rooms.delete(code);
    this.broadcastRoomList();
  }

  joinRoom(code, ws, { id, name, token, user = '' }) {
    const room = this.getRoom(code);
    if (!room) return { error: '房间不存在' };
    if (room.players.size >= room.settings.maxPlayers && !room.players.has(id)) {
      return { error: '房间已满' };
    }
    const np = room.addPlayer(ws, { id, name, token, user });
    this.players.set(id, { roomCode: room.code, id });
    room.chat_('系统', `${name} 加入了房间`, true);
    room.broadcastRoom();
    this.broadcastRoomList();
    return { room, np };
  }

  leaveRoom(id) {
    const rec = this.players.get(id);
    if (!rec) return;
    const room = this.rooms.get(rec.roomCode);
    this.players.delete(id);
    if (room) {
      const np = room.players.get(id);
      room.removePlayer(id);
      if (np) room.chat_('系统', `${np.name} 离开了房间`, true);
      room.broadcastRoom();
      this.broadcastRoomList();
    }
  }

  roomList() {
    return [...this.rooms.values()].map((r) => r.summary());
  }

  broadcastRoomList() {
    const list = this.roomList();
    const payload = JSON.stringify({ t: 'rooms', rooms: list });
    for (const ws of this.lobbySockets) {
      if (ws.readyState === 1) { try { ws.send(payload); } catch { /* ignore */ } }
    }
    // 房间内的人也顺带更新（便于看到房间人数变化）
    for (const room of this.rooms.values()) {
      for (const p of room.players.values()) {
        if (p.ws && p.ws.readyState === 1) { try { p.ws.send(payload); } catch { /* ignore */ } }
      }
    }
  }

  addLobbySocket(ws) { this.lobbySockets.add(ws); send(ws, { t: 'rooms', rooms: this.roomList() }); }
  removeLobbySocket(ws) { this.lobbySockets.delete(ws); }

  tickAll(dt) {
    for (const room of [...this.rooms.values()]) {
      try { room.tick(dt); } catch (e) {
        console.error('[room tick error]', room.code, e);
      }
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      players: this.players.size,
      maxPlayersPerRoom: MAX_PLAYERS,
    };
  }
}
