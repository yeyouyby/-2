// 检查点存档：把一局 PvE / 无尽 跑到「某一波开始前」的状态写成一份明文 JSON，之后从这里继续。
//
// 为什么是检查点而不是全量快照：场上敌人 / 弹幕 / 掉落每 tick 都在变，连它们一起存就得把
// 客户端预测回滚一起扯进来（读档瞬间的位置大跳变很容易被本地预测吃回去）。波次边界是天然的
// 干净点：商店开着、人站在地面、怪清空 —— 只需要存「成长」和「进度」，恢复出来就是一局正常的新对局。
import { PHASE } from '../../../shared/constants.js';
import { itemById } from '../../../shared/items.js';
import { weaponById } from '../../../shared/weapons.js';
import { recomputeStats, xpForLevel } from '../game/player.js';
import * as Shop from '../game/shop.js';

const MAX_LABEL = 24;

/** 一局里「可恢复」的那部分 */
export function checkpointOf(game, { label = '', owners = [], code = '', wave } = {}) {
  return {
    label: String(label || '').slice(0, MAX_LABEL),
    code: String(code || '').slice(0, 8),
    owners: owners.map((u) => String(u).slice(0, 20)),
    createdAt: Date.now(),
    mode: game.settings.mode,
    settings: {
      mode: game.settings.mode,
      levelId: game.settings.levelId,
      difficulty: game.settings.difficulty,
      prepTime: game.settings.prepTime,
      totalWaves: game.settings.totalWaves,
      endlessBonusEvery: game.settings.endlessBonusEvery,
    },
    seed: game.seed >>> 0,
    rngState: game.rng.getState(),          // 随机数用到哪儿了也记下 → 读档后下一波和原来一致
    tick: game.tick,
    time: Math.round(game.time * 10) / 10,
    wave: wave === undefined ? game.wave : Math.max(0, wave | 0),   // 已完成的波数；恢复后下一波是 wave + 1
    players: [...game.players.values()].map((p) => ({
      user: p.user || '',
      name: p.name,
      slot: p.slot,
      team: p.team,
      level: p.level,
      xp: Math.round(p.xp),
      coins: Math.round(p.coins),
      kills: p.kills,
      deaths: p.deaths,
      damage: Math.round(p.damageDealt),
      taken: Math.round(p.damageTaken),
      hp: Math.ceil(p.hp),
      items: { ...p.items },
      weapons: p.weapons.map((w) => w.id),
    })),
  };
}

/** 把检查点套到一局刚开好、还没进波次的 Game 上 */
export function applyCheckpoint(game, run) {
  const warnings = [];
  const wave = Math.max(0, Math.min(9999, Number(run.wave) || 0));
  game.seed = Number(run.seed) >>> 0 || game.seed;
  if (Number.isFinite(Number(run.rngState))) game.rng.setState(Number(run.rngState));
  game.tick = Math.max(0, Number(run.tick) || 0);
  game.time = Math.max(0, Number(run.time) || 0);
  game.wave = wave;

  const byUser = new Map();
  const byName = new Map();
  for (const p of game.players.values()) {
    if (p.user) byUser.set(String(p.user).toLowerCase(), p);
    byName.set(String(p.name || '').toLowerCase(), p);
  }

  const saved = run.players || [];
  let restored = 0;
  for (const r of saved) {
    const key = String(r.user || '').toLowerCase();
    let p = key ? byUser.get(key) : null;
    if (!p) {
      // 显示名兜底只给「没有账号归属的记录」（老存档/游客）用；有 user 却查不到人，
      // 说明那个人不在房间里 —— 这时候按名字硬套，等于让同名的人白拿别人一整套 build
      const cand = byName.get(String(r.name || '').toLowerCase());
      if (cand && !key && !cand.user) p = cand;
    }
    if (!p) {
      warnings.push(`${r.name || r.user || '某玩家'} 不在这个房间里（或账号对不上），他的成长没恢复`);
      continue;
    }
    // 先把道具灌回去（maxHp 这类是道具算出来的），再把血量覆盖成存档当时的值
    p.items = {};
    for (const [id, n] of Object.entries(r.items || {})) {
      if (!itemById(id)) continue;
      const count = Math.max(0, Math.min(99, Number(n) || 0));
      if (count > 0) p.items[id] = count;
    }
    p.weapons = [];
    for (const id of (r.weapons || []).slice(0, 6)) {
      if (weaponById(id) && !p.weapons.some((w) => w.id === id)) p.weapons.push({ id, cd: 0 });
    }
    if (!p.weapons.length) p.weapons.push({ id: 'pistol', cd: 0 });
    recomputeStats(p);
    p.level = Math.max(1, Math.min(999, Number(r.level) || 1));
    p.xpNeed = xpForLevel(p.level);
    p.xp = Math.max(0, Math.min(p.xpNeed, Number(r.xp) || 0));
    p.coins = Math.max(0, Math.min(999999, Number(r.coins) || 0));
    p.kills = Math.max(0, Number(r.kills) || 0);
    p.deaths = Math.max(0, Number(r.deaths) || 0);
    p.damageDealt = Math.max(0, Number(r.damage) || 0);
    p.damageTaken = Math.max(0, Number(r.taken) || 0);
    p.alive = true; p.downed = false; p.downTimer = 0; p.reviveProgress = 0;
    p.hp = Math.max(1, Math.min(p.maxHp, Number(r.hp) || p.maxHp));
    p.pendingLevels = 0; p.choices = null;
    game.placeAtSpawn(p);
    restored++;
  }
  // 房间里但存档里没记录的人：按当前 build 进这一波，明确提示一下别让人以为丢了进度
  for (const p of game.players.values()) {
    const known = saved.some((r) => (r.user && p.user && String(r.user).toLowerCase() === String(p.user).toLowerCase())
      || (!r.user && !p.user && r.name === p.name));
    if (!known) warnings.push(`${p.name} 没有对应的存档记录，按当前 build 加入第 ${wave + 1} 波`);
  }

  // 停在商店阶段：读档的人先逛一轮再进下一波，和正常波间一模一样
  game.phase = PHASE.PREP;
  game.phaseTimer = game.settings.prepTime || 20;
  for (const p of game.players.values()) Shop.rollShop(game, p);
  return { restored, wave, warnings };
}

/** 存档列表里那一行的展示数据 */
export function saveSummary(run) {
  if (!run) return null;
  return {
    id: run.id,
    label: run.label || `${run.mode === 'endless' ? '无尽' : 'PvE'} 第 ${(run.wave | 0) + 1} 波前`,
    mode: run.mode,
    wave: (run.wave | 0) + 1,
    createdAt: run.createdAt,
    owners: run.owners || [],
    players: (run.players || []).map((p) => ({ name: p.name, level: p.level, kills: p.kills })),
  };
}
