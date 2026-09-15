// 武器定义（前后端共享：客户端需要名称/图标色/描述，服务器需要数值）
// dmgType 决定吃哪一种加成：melee / ranged / magic

export const WEAPONS = [
  {
    id: 'pistol', name: '手枪', type: 'ranged', dmgType: 'ranged', tier: 1,
    cd: 0.5, dmg: 12, speed: 950, range: 640, pierce: 0, kb: 90,
    color: '#ffd36e', size: 5, desc: '稳定的远程输出，新手好朋友。',
  },
  {
    id: 'fist', name: '拳套', type: 'melee', dmgType: 'melee', tier: 1,
    cd: 0.28, dmg: 9, reach: 52, kb: 160,
    color: '#e8b98a', size: 6, desc: '出拳极快，贴脸连打。',
  },
  {
    id: 'stick', name: '木棍', type: 'melee', dmgType: 'melee', tier: 1,
    cd: 0.45, dmg: 16, reach: 64, kb: 200,
    color: '#b98b52', size: 7, desc: '一根趁手的棍子，谁都能用。',
  },
  {
    id: 'smg', name: '冲锋枪', type: 'ranged', dmgType: 'ranged', tier: 2,
    cd: 0.1, dmg: 5, speed: 1000, range: 540, pierce: 0, spread: 0.09, kb: 40,
    color: '#9fe8ff', size: 4, desc: '泼水一样的弹幕，单发很轻。',
  },
  {
    id: 'shotgun', name: '霰弹枪', type: 'ranged', dmgType: 'ranged', tier: 2,
    cd: 0.85, dmg: 6, pellets: 5, spread: 0.42, speed: 820, range: 360, pierce: 0, kb: 150,
    color: '#ff9a6e', size: 4, desc: '近距离一发糊脸，穿透为 0。',
  },
  {
    id: 'sword', name: '长剑', type: 'melee', dmgType: 'melee', tier: 2,
    cd: 0.68, dmg: 30, reach: 84, kb: 340,
    color: '#cfe6ff', size: 8, desc: '一刀两段，击退很强。',
  },
  {
    id: 'staff', name: '法杖', type: 'ranged', dmgType: 'magic', tier: 2,
    cd: 0.62, dmg: 15, speed: 520, range: 700, pierce: 1, homing: 4.2,
    color: '#c79bff', size: 7, desc: '追踪魔法弹，会自己拐弯。',
  },
  {
    id: 'sniper', name: '狙击枪', type: 'ranged', dmgType: 'ranged', tier: 3,
    cd: 1.25, dmg: 58, speed: 1700, range: 1600, pierce: 3, kb: 220,
    color: '#ffe066', size: 5, desc: '一枪一条线，穿透 3 个目标。',
  },
  {
    id: 'boomerang', name: '回旋镖', type: 'ranged', dmgType: 'ranged', tier: 3,
    cd: 0.95, dmg: 13, speed: 720, range: 520, pierce: 99, ret: true,
    color: '#8ce99a', size: 8, desc: '飞出去还会回来，路上无限穿透。',
  },
  {
    id: 'rocket', name: '火箭筒', type: 'ranged', dmgType: 'ranged', tier: 3,
    cd: 1.5, dmg: 32, speed: 640, range: 900, pierce: 0, aoe: 108, kb: 260,
    color: '#ff6b6b', size: 7, desc: '命中爆炸，范围伤害。',
  },
  {
    id: 'chainsaw', name: '电锯', type: 'melee', dmgType: 'melee', tier: 3,
    cd: 0.12, dmg: 11, reach: 60, kb: 60,
    color: '#ffd43b', size: 7, desc: '每秒锯 8 下，贴身绞肉机。',
  },
  {
    id: 'laser', name: '激光枪', type: 'ranged', dmgType: 'magic', tier: 4,
    cd: 0.34, dmg: 20, hitscan: true, range: 900, pierce: 99,
    color: '#ff4ddb', size: 3, desc: '瞬间命中，贯穿一条直线上的所有敌人。',
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const TIER_PRICE = { 1: 18, 2: 32, 3: 55, 4: 90 };
export const TIER_COLOR = { 1: '#9fb3c8', 2: '#4dd4ac', 3: '#a78bfa', 4: '#fbbf24' };

export function weaponById(id) {
  return WEAPON_BY_ID[id];
}
