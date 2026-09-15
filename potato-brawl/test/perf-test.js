// 性能基准：直接驱动游戏世界（不经网络），把怪物/弹幕压满，测量 tick 耗时与快照体积
import { Game } from '../server/src/game/game.js';
import { TICK_DT, IN } from '../shared/constants.js';
import { ENEMY_DEFS } from '../shared/enemies.js';

const PLAYERS = Number(process.argv[2] || 8);
const ENEMIES = Number(process.argv[3] || 70);
const WAVE = Number(process.argv[4] || 14);
const TICKS = Number(process.argv[5] || 3000);

const room = {
  settings: {
    mode: 'pve', levelId: 'farm', maxPlayers: 8, totalWaves: 20,
    difficulty: 1, prepTime: 20, scoreLimit: 20, timeLimit: 300, teamSize: 2,
  },
  seed: 20240911,
};

const g = new Game(room);
const ids = [];
for (let i = 0; i < PLAYERS; i++) {
  const np = { id: 'p' + i, name: '玩家' + i, slot: i, team: 0, startWeapon: ['pistol', 'fist', 'stick', 'smg'][i % 4] };
  g.addPlayer(np);
  ids.push('p' + i);
}
g.start();
g.beginWave(WAVE);

// 塞满敌人 + 给玩家一身神装，让弹幕也压满
const weaponPool = ['pistol', 'smg', 'shotgun', 'staff', 'sniper', 'chainsaw'];
for (const p of g.players.values()) {
  for (const w of weaponPool) if (p.weapons.length < 6) p.weapons.push({ id: w, cd: 0 });
  for (const [k, v] of Object.entries({ coffee: 6, adrenaline: 2, barrel: 2, critcore: 2, crown: 1 })) p.items[k] = v;
}
const types = Object.keys(ENEMY_DEFS).filter((t) => t !== 'boss');
for (let i = 0; i < ENEMIES; i++) {
  g.spawnEnemy(types[i % types.length], 100 + (i * 37) % 1400, 300 + (i * 53) % 500, { elite: i % 7 === 0 });
}
for (let i = 0; i < 3; i++) g.spawnEnemy('boss', 300 + i * 400, 600);

let peak = 0;
const times = [];
for (let t = 0; t < TICKS; t++) {
  // 随机输入
  for (const p of g.players.values()) {
    p.input = ((t + p.slot * 7) % 120 < 60 ? IN.RIGHT : IN.LEFT) | (t % 97 === 0 ? IN.JUMP : 0) | (t % 211 === 0 ? IN.DASH : 0);
    // 让基准跑满：玩家保持存活，否则对局会被判负而停止开火
    p.alive = true; p.downed = false; p.hp = p.maxHp;
  }
  if (g.phase === 'over') { g.phase = 'wave'; g.result = null; }
  const t0 = performance.now();
  g.update(TICK_DT);
  times.push(performance.now() - t0);
  peak = Math.max(peak, g.enemies.length + g.projectiles.length + g.pickups.length);
  // 持续补怪，保持压力
  if (t % 30 === 0 && g.enemies.length < ENEMIES) {
    g.spawnEnemy(types[(t / 30) % types.length], 100 + (t * 17) % 1400, 600);
  }
}

const snap = JSON.stringify(g.snapshot('p0'));
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const sorted = [...times].sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const p99 = sorted[Math.floor(sorted.length * 0.99)];

console.log(`\n=== 性能基准：${PLAYERS} 名玩家 · 第 ${WAVE} 波 · 目标 ${ENEMIES} 怪 · ${TICKS} tick ===`);
console.log(`  平均 tick     : ${avg.toFixed(3)} ms   （60Hz 预算 16.67ms，占用 ${(avg / 16.67 * 100).toFixed(1)}%）`);
console.log(`  p95 / p99     : ${p95.toFixed(3)} ms / ${p99.toFixed(3)} ms`);
console.log(`  最慢 tick     : ${Math.max(...times).toFixed(3)} ms`);
console.log(`  峰值实体      : ${peak}（敌人 ${g.enemies.length} + 弹幕 ${g.projectiles.length} + 掉落 ${g.pickups.length}）`);
console.log(`  快照大小      : ${(snap.length / 1024).toFixed(1)} KB / 帧 → ${(snap.length * 20 * PLAYERS / 1024 / 1024).toFixed(2)} MB/s（${PLAYERS} 人 × 20Hz）`);
console.log(`  可支撑玩家数  : 约 ${Math.floor(16.67 / Math.max(0.05, avg) / 20 * 20)} 人同房间（按 tick 预算粗算）`);
console.log(`  ${avg < 4 ? '✅ 服务器负载健康' : avg < 10 ? '⚠️ 偏高但可接受' : '❌ 过高'}\n`);
