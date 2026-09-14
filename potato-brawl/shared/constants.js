// 前后端共享的常量。客户端做移动预测时需要与服务器完全一致。
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_EVERY = TICK_RATE / SNAPSHOT_HZ; // 每 3 tick 发一次快照

export const MAX_PLAYERS = 8;
export const MAX_WEAPONS = 6;
export const ROOM_CODE_LEN = 4;

// 输入位掩码（客户端每 tick 上报）
export const IN = {
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  JUMP: 1 << 2,
  DASH: 1 << 3,
  DOWN: 1 << 4,
  REVIVE: 1 << 5,
};

export const PHYS = {
  gravity: 2300,
  maxFall: 1250,
  accel: 2600,
  airAccel: 1700,
  friction: 3000,
  airFriction: 600,
  jumpVel: 690,
  doubleJumpVel: 600,
  maxJumps: 2,
  coyote: 0.10,
  jumpBuffer: 0.12,
  dashSpeed: 950,
  dashTime: 0.15,
  dashCooldown: 1.1,
  dashIFrames: 0.20,
};

export const PLAYER = {
  w: 26,
  h: 42,
  baseHp: 100,
  baseSpeed: 255,
  pickupRadius: 70,
  respawnDelay: 3,
  reviveTime: 3,
  reviveRange: 70,
  downTime: 25,
};

export const PLAYER_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#22b8cf', '#ff922b', '#f783ac'];

export const MODE = { PVE: 'pve', FFA: 'ffa', TEAM: 'team' };
export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PREP: 'prep',     // PvE 波间备战 / 商店
  WAVE: 'wave',     // PvE 战斗中
  PLAYING: 'playing', // PvP
  OVER: 'over',
};

export const TEAM = { A: 0, B: 1, NONE: -1 };

// 阵营：用于伤害/瞄准过滤
export const FACTION = { PLAYER: 'player', ENEMY: 'enemy' };

export const DEFAULT_SETTINGS = {
  mode: MODE.PVE,
  levelId: 'farm',
  maxPlayers: 4,
  // PvE
  totalWaves: 20,
  difficulty: 1,
  prepTime: 20,
  // PvP
  scoreLimit: 20,
  timeLimit: 300,
  teamSize: 2,
};

export const PVP = {
  crateInterval: 12,
  healInterval: 18,
  ffaScore: 20,
  teamScore: 30,
};
