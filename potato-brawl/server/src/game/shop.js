// 波间商店（合作 PvE）
import { ITEMS, RARITY_PRICE, RARITY_WEIGHT } from '../../../shared/items.js';
import { WEAPONS, TIER_PRICE } from '../../../shared/weapons.js';
import { grantItem, grantWeapon } from './player.js';

function priceOf(kind, def, wave, rng) {
  const base = kind === 'item' ? RARITY_PRICE[def.rarity] : TIER_PRICE[def.tier];
  const varia = 0.9 + rng() * 0.25;
  return Math.max(4, Math.round(base * (1 + wave * 0.055) * varia));
}

function pickWeighted(pool, weightFn, rng) {
  const total = pool.reduce((a, x) => a + weightFn(x), 0);
  let r = rng() * total;
  for (const x of pool) {
    r -= weightFn(x);
    if (r <= 0) return x;
  }
  return pool[pool.length - 1];
}

/** 生成某玩家的商店（波间调用） */
export function rollShop(game, p, { keepRolls = false } = {}) {
  const rng = game.rng;
  const wave = game.wave;
  const offers = [];
  const owned = p.weapons.map((w) => w.id);

  const itemPool = ITEMS.filter((it) => (p.items[it.id] || 0) < it.max && !offers.some((o) => o.id === it.id));
  const weaponPool = WEAPONS.filter((w) => !owned.includes(w.id) && !offers.some((o) => o.id === w.id));

  const nWeapons = owned.length < 6 ? (weaponPool.length ? 2 : 0) : 0;
  const nItems = 5 - nWeapons;

  for (let i = 0; i < nItems && itemPool.length; i++) {
    const it = pickWeighted(itemPool, (x) => RARITY_WEIGHT[x.rarity] + (p.items[x.id] ? RARITY_WEIGHT[x.rarity] * 0.3 : 0), rng);
    itemPool.splice(itemPool.indexOf(it), 1);
    offers.push({ kind: 'item', id: it.id, price: priceOf('item', it, wave, rng), sold: false });
  }
  for (let i = 0; i < nWeapons && weaponPool.length; i++) {
    const w = pickWeighted(weaponPool, (x) => [0, 1, 1, 0.7, 0.35][x.tier] || 0.5, rng);
    weaponPool.splice(weaponPool.indexOf(w), 1);
    offers.push({ kind: 'weapon', id: w.id, price: priceOf('weapon', w, wave, rng), sold: false });
  }

  p.shop = { offers, rolls: keepRolls ? p.shop?.rolls || 0 : 0, ready: false };
  return p.shop;
}

export function rerollCost(game, p) {
  return 4 + (p.shop?.rolls || 0) * 3 + Math.floor(game.wave * 0.6);
}

export function shopReroll(game, p) {
  if (!p.shop) return { ok: false, msg: '不在商店阶段' };
  const cost = rerollCost(game, p);
  if (p.coins < cost) return { ok: false, msg: '金币不足' };
  p.coins -= cost;
  const rolls = p.shop.rolls + 1;
  rollShop(game, p);
  p.shop.rolls = rolls;
  return { ok: true };
}

export function shopBuy(game, p, index) {
  if (!p.shop) return { ok: false, msg: '不在商店阶段' };
  const offer = p.shop.offers[index];
  if (!offer) return { ok: false, msg: '没有这件商品' };
  if (offer.sold) return { ok: false, msg: '已售出' };
  if (p.coins < offer.price) return { ok: false, msg: '金币不足' };
  if (offer.kind === 'weapon' && p.weapons.length >= 6) return { ok: false, msg: '武器栏已满' };
  p.coins -= offer.price;
  offer.sold = true;
  if (offer.kind === 'item') grantItem(p, offer.id);
  else grantWeapon(p, offer.id);
  game.addEvent({ t: 'buy', id: p.id, k: offer.kind, v: offer.id });
  return { ok: true };
}
