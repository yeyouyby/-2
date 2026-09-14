// 房间管理：创建 / 加入 / 列表 / 清理
import { MAX_PLAYERS } from '../../../shared/constants.js';
import { Room, makeCode, send } from './room.js';

export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.players = new Map(); // wsId -> {roomCode, id}
    this.lobbySockets = new Set(); // 在大厅（未加入房间）的连接
  }

  createRoom(opts) {
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
    this.rooms.delete(code);
    this.broadcastRoomList();
  }

  joinRoom(code, ws, { id, name, token }) {
    const room = this.getRoom(code);
    if (!room) return { error: '房间不存在' };
    if (room.players.size >= room.settings.maxPlayers && !room.players.has(id)) {
      return { error: '房间已满' };
    }
    if (room.game && room.game.phase !== 'over' && room.settings.mode === 'pve' && room.game.wave > 0) {
      // 允许中途加入，但提示
    }
    const np = room.addPlayer(ws, { id, name, token });
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
