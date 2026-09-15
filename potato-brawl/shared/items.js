// 道具（升级/商店共用）：Brotato 式的「堆属性」build 系统
export const RARITY = ['common', 'rare', 'epic', 'legendary'];
export const RARITY_NAME = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
export const RARITY_COLOR = { common: '#b9c6d4', rare: '#4da3ff', epic: '#c084fc', legendary: '#fbbf24' };
export const RARITY_PRICE = { common: 14, rare: 26, epic: 44, legendary: 78 };
export const RARITY_WEIGHT = { common: 100, rare: 42, epic: 14, legendary: 4 };

/** 玩家最终属性 = 基础值 + 所有道具累加 */
export function emptyStats() {
  return {
    damageMul: 1, atkSpeed: 1,
    meleeDmg: 0, rangedDmg: 0, magicDmg: 0,
    crit: 0.05, critMul: 2,
    speedMul: 1, jumpMul: 1, dashCdMul: 1,
    maxHpAdd: 0, armor: 0, armorPct: 0, dodge: 0,
    lifesteal: 0, regen: 0, thorns: 0,
    pickup: 0, extraProj: 0, projSpeedMul: 1, rangeMul: 1,
    xpMul: 1, coinMul: 1, luck: 0,
    explode: 0,
  };
}

const I = (id, name, desc, rarity, stats, max = 99) => ({ id, name, desc, rarity, stats, max });

export const ITEMS = [
  // ---------- 普通 ----------
  I('armor', '护甲板', '受到伤害 -2（固定减伤）', 'common', { armor: 2 }, 8),
  I('coffee', '咖啡', '攻击速度 +10%', 'common', { atkSpeed: 0.1 }, 6),
  I('muscle', '肌肉纤维', '近战伤害 +3', 'common', { meleeDmg: 3 }, 8),
  I('belt', '弹链', '远程伤害 +3', 'common', { rangedDmg: 3 }, 8),
  I('shoes', '运动鞋', '移动速度 +7%', 'common', { speedMul: 0.07 }, 6),
  I('apple', '苹果', '最大生命 +15', 'common', { maxHpAdd: 15 }, 10),
  I('magnet', '磁铁', '拾取范围 +40', 'common', { pickup: 40 }, 4),
  I('dagger', '匕首', '暴击率 +4%', 'common', { crit: 0.04 }, 8),
  I('bandage', '绷带', '每秒回复 +1.2 生命', 'common', { regen: 1.2 }, 6),
  I('glasses', '瞄准镜', '暴击伤害 +25%', 'common', { critMul: 0.25 }, 4),
  I('book', '教科书', '经验获取 +12%', 'common', { xpMul: 0.12 }, 5),
  I('cloak', '斗篷', '闪避率 +4%', 'common', { dodge: 0.04 }, 6),
  I('scope', '望远镜', '攻击范围 +12%', 'common', { rangeMul: 0.12 }, 4),
  I('powder', '火药', '弹速 +18%', 'common', { projSpeedMul: 0.18 }, 4),
  I('spring', '弹簧', '跳跃高度 +8%，冲刺冷却 -12%', 'common', { jumpMul: 0.08, dashCdMul: -0.12 }, 4),
  I('piggy', '存钱罐', '金币获取 +15%', 'common', { coinMul: 0.15 }, 5),
  I('thorn', '荆棘', '反伤 +12', 'common', { thorns: 12 }, 5),
  I('fang', '吸血獠牙', '吸血 +3%', 'common', { lifesteal: 0.03 }, 5),

  // ---------- 稀有 ----------
  I('helmet', '铁盔', '最大生命 +30，移动速度 -3%', 'rare', { maxHpAdd: 30, speedMul: -0.03 }, 4),
  I('boots', '重靴', '受到伤害 -4，移动速度 -5%', 'rare', { armor: 4, speedMul: -0.05 }, 4),
  I('berserk', '狂战面具', '全伤害 +15%，最大生命 -8', 'rare', { damageMul: 0.15, maxHpAdd: -8 }, 3),
  I('barrel', '双管改造', '远程弹丸 +1，远程伤害 -2', 'rare', { extraProj: 1, rangedDmg: -2 }, 2),
  I('drink', '能量饮料', '冲刺冷却 -25%，移动速度 +5%', 'rare', { dashCdMul: -0.25, speedMul: 0.05 }, 3),
  I('tnt', '炸药包', '击杀时 18% 概率爆炸', 'rare', { explode: 0.18 }, 4),
  I('clover', '幸运草', '幸运 +2，暴击率 +3%', 'rare', { luck: 2, crit: 0.03 }, 4),
  I('wizard', '巫师帽', '魔法伤害 +6', 'rare', { magicDmg: 6 }, 6),
  I('feast', '大餐', '最大生命 +45，移动速度 -4%', 'rare', { maxHpAdd: 45, speedMul: -0.04 }, 3),
  I('stone', '磨刀石', '近战伤害 +6', 'rare', { meleeDmg: 6 }, 6),

  // ---------- 史诗 ----------
  I('exo', '外骨骼', '受到伤害 -8，最大生命 +20', 'epic', { armor: 8, maxHpAdd: 20 }, 2),
  I('adrenaline', '肾上腺素', '攻击速度 +25%', 'epic', { atkSpeed: 0.25 }, 2),
  I('giant', '巨人腰带', '最大生命 +70，移动速度 -6%', 'epic', { maxHpAdd: 70, speedMul: -0.06 }, 2),
  I('critcore', '暴击核心', '暴击率 +12%，暴击伤害 +30%', 'epic', { crit: 0.12, critMul: 0.3 }, 2),
  I('fuel', '火箭燃料', '弹速 +35%，攻击范围 +20%', 'epic', { projSpeedMul: 0.35, rangeMul: 0.2 }, 2),
  I('shield', '能量护盾', '受到伤害 -18%，闪避 +6%', 'epic', { armorPct: 0.18, dodge: 0.06 }, 2),

  // ---------- 传说 ----------
  I('crown', '土豆王冠', '全伤害 +35%，攻击速度 +15%', 'legendary', { damageMul: 0.35, atkSpeed: 0.15 }, 1),
  I('bloodlord', '血族之心', '吸血 +10%，最大生命 +25', 'legendary', { lifesteal: 0.1, maxHpAdd: 25 }, 1),
  I('windboot', '疾风之靴', '移动速度 +30%，冲刺冷却 -40%', 'legendary', { speedMul: 0.3, dashCdMul: -0.4 }, 1),
  I('titan', '泰坦之躯', '最大生命 +150，受到伤害 -10，移动速度 -10%', 'legendary', { maxHpAdd: 150, armor: 10, speedMul: -0.1 }, 1),
  I('nuke', '微型核弹', '击杀时 50% 概率引发大爆炸', 'legendary', { explode: 0.5 }, 1),
];

export const ITEM_BY_ID = Object.fromEntries(ITEMS.map((it) => [it.id, it]));

export function itemById(id) {
  return ITEM_BY_ID[id];
}

/** 累加所有道具得到最终属性 */
export function computeStats(itemCounts) {
  const s = emptyStats();
  for (const [id, n] of Object.entries(itemCounts || {})) {
    const it = ITEM_BY_ID[id];
    if (!it || n <= 0) continue;
    for (const [k, v] of Object.entries(it.stats)) {
      s[k] = (s[k] || 0) + v * n;
    }
  }
  // 收敛，避免极端堆叠
  s.dodge = Math.min(s.dodge, 0.6);
  s.armorPct = Math.min(s.armorPct, 0.6);
  s.crit = Math.min(s.crit, 1);
  s.speedMul = Math.max(0.4, s.speedMul);
  s.atkSpeed = Math.min(s.atkSpeed, 4);
  return s;
}

/**
 * 抽取升级三选一。rng: ()=>float。
 * @returns {Array<{kind:'item'|'weapon', id:string}>}
 */
export function rollUpgrades(rng, { items = {}, weapons = [], count = 3, weaponChance = 0.22, allowWeapon = true } = {}) {
  const picks = [];
  const used = new Set();
  let guard = 0;
  while (picks.length < count && guard++ < 200) {
    if (allowWeapon && weapons.length < 6 && rng() < weaponChance) {
      const w = WEAPON_POOL_ROLL(rng, weapons);
      if (w && !used.has('w:' + w)) { picks.push({ kind: 'weapon', id: w }); used.add('w:' + w); }
      continue;
    }
    // 按稀有度加权抽道具
    const pool = ITEMS.filter((it) => (items[it.id] || 0) < it.max && !used.has('i:' + it.id));
    if (!pool.length) break;
    const total = pool.reduce((a, it) => a + (RARITY_WEIGHT[it.rarity] + (items[it.id] ? RARITY_WEIGHT[it.rarity] * 0.25 : 0)), 0);
    let r = rng() * total;
    let chosen = pool[pool.length - 1];
    for (const it of pool) {
      const w = RARITY_WEIGHT[it.rarity] + (items[it.id] ? RARITY_WEIGHT[it.rarity] * 0.25 : 0);
      if (r < w) { chosen = it; break; }
      r -= w;
    }
    picks.push({ kind: 'item', id: chosen.id });
    used.add('i:' + chosen.id);
  }
  return picks;
}

function WEAPON_POOL_ROLL(rng, owned) {
  const pool = ['pistol', 'fist', 'stick', 'smg', 'shotgun', 'sword', 'staff', 'sniper', 'boomerang', 'rocket', 'chainsaw', 'laser']
    .filter((id) => !owned.includes(id));
  if (!pool.length) return null;
  // 高阶武器权重更高
  const weights = pool.map((id) => {
    const t = (ITEM_BY_ID[id] ? 1 : 1);
    const tier = { pistol: 1, fist: 1, stick: 1, smg: 2, shotgun: 2, sword: 2, staff: 2, sniper: 3, boomerang: 3, rocket: 3, chainsaw: 3, laser: 4 }[id] || 1;
    return [1, 1, 0.7, 0.35][tier - 1] || 0.4;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    if (r < weights[i]) return pool[i];
    r -= weights[i];
  }
  return pool[pool.length - 1];
}
