// 敌人数值表（前后端共享：客户端需要体型/颜色/名字来渲染）
export const ENEMY_DEFS = {
  slime: { name: '史莱姆', w: 30, h: 30, hp: 34, speed: 88, dmg: 9, xp: 3, color: '#7bd389', ai: 'hop', kbResist: 0 },
  rusher: { name: '疯跑鸡', w: 26, h: 38, hp: 28, speed: 215, dmg: 11, xp: 4, color: '#ff8787', ai: 'rush', kbResist: 0 },
  flyer: { name: '飞虫', w: 30, h: 22, hp: 24, speed: 165, dmg: 8, xp: 4, color: '#a5d8ff', ai: 'fly', flying: true, kbResist: 0.2 },
  shooter: { name: '射手菌', w: 28, h: 40, hp: 40, speed: 72, dmg: 10, xp: 5, color: '#ffd43b', ai: 'shoot', kbResist: 0 },
  tank: { name: '石头人', w: 46, h: 50, hp: 190, speed: 60, dmg: 22, xp: 9, color: '#adb5bd', ai: 'tank', kbResist: 0.65 },
  bomber: { name: '炸弹怪', w: 28, h: 28, hp: 32, speed: 140, dmg: 28, xp: 6, color: '#ff6b6b', ai: 'bomb', kbResist: 0 },
  boss: { name: '土豆王', w: 78, h: 88, hp: 1300, speed: 85, dmg: 26, xp: 80, color: '#e8b04b', ai: 'boss', boss: true, kbResist: 0.95 },
};

// 每波解锁的敌人种类
export const WAVE_TABLE = [
  { from: 1, types: ['slime'] },
  { from: 2, types: ['slime', 'rusher'] },
  { from: 3, types: ['slime', 'rusher', 'flyer'] },
  { from: 4, types: ['slime', 'rusher', 'flyer', 'shooter'] },
  { from: 6, types: ['slime', 'rusher', 'flyer', 'shooter', 'tank'] },
  { from: 8, types: ['slime', 'rusher', 'flyer', 'shooter', 'tank', 'bomber'] },
];

export function typesForWave(wave) {
  let out = ['slime'];
  for (const row of WAVE_TABLE) if (wave >= row.from) out = row.types;
  return out;
}

/** 波次难度缩放 */
export function scaleForWave(wave, difficulty = 1) {
  const w = Math.max(1, wave);
  return {
    hp: (1 + 0.24 * (w - 1) + 0.007 * (w - 1) * (w - 1)) * difficulty,
    dmg: (1 + 0.09 * (w - 1)) * difficulty,
    speed: Math.min(1.5, 1 + 0.012 * (w - 1)),
  };
}
