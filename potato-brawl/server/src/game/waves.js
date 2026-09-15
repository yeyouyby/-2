// 波次编排
import { typesForWave, scaleForWave } from '../../../shared/enemies.js';

/**
 * 生成一波的出场队列：每项 { type, t(秒), elite }
 */
export function buildWaveQueue(game, wave) {
  const rng = game.rng;
  const types = typesForWave(wave);
  const queue = [];
  const isBoss = wave % 5 === 0;

  if (isBoss) {
    queue.push({ type: 'boss', t: 1.2 });
    const adds = Math.round(3 + wave * 0.5);
    for (let i = 0; i < adds; i++) {
      queue.push({ type: rng.pick(types), t: 3.2 + i * 1.1, elite: rng() < 0.15 });
    }
    return queue;
  }

  const budget = Math.round(Math.min(52, 7 + wave * 2.6) * game.settings.difficulty);
  const batch = 3 + Math.floor(wave / 3);
  const interval = 3.6;
  let spawned = 0, t = 0.6;
  while (spawned < budget) {
    const n = Math.min(batch, budget - spawned);
    for (let i = 0; i < n; i++) {
      queue.push({
        type: rng.pick(types),
        t: t + i * 0.28,
        elite: rng() < Math.min(0.22, wave * 0.018),
      });
    }
    spawned += n;
    t += interval;
  }
  return queue;
}

export function waveScale(game, wave) {
  return scaleForWave(wave, game.settings.difficulty);
}
