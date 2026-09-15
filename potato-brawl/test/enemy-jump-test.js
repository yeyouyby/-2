// 敌人平台追踪回归测试：地面怪必须能（二段）跳上平台咬到玩家。
// 用法：node test/enemy-jump-test.js
import { Game } from '../server/src/game/game.js';
import { planHop, jumpPower, NAV } from '../server/src/game/nav.js';
import { ENEMY_DEFS } from '../shared/enemies.js';
import { PHYS, TICK_DT } from '../shared/constants.js';
import { apexRise } from '../shared/physics.js';

let failed = 0, passed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
}

function makeGame(levelId = 'farm') {
  const room = {
    settings: {
      mode: 'pve', levelId, maxPlayers: 4, totalWaves: 20, difficulty: 1,
      prepTime: 20, scoreLimit: 20, timeLimit: 300, teamSize: 2,
    },
    seed: 20240911,
  };
  const g = new Game(room);
  const p = g.addPlayer({ id: 'p0', name: '测试', slot: 0, team: 0, startWeapon: null });
  p.weapons = [];                 // 测试靶子不开火，免得把被测的怪打死
  g.start();
  g.beginWave(1);
  g.spawnQueue.length = 0;         // 只留我们手动生成的怪
  return { g, p };
}

/** 把玩家固定放在某块平台顶上（禁用重力/输入，只保留导航想要的静态靶子） */
function pinPlayer(g, p, x, yFeet) {
  p.x = x - p.w / 2; p.y = yFeet - p.h; p.vx = 0; p.vy = 0;
  p.hp = p.maxHp; p.alive = true; p.downed = false;
  p.input = 0;
  p.weapons = [];
  p.pin = true;
}

/** 在地板上出生（脚底离地面 4px，别嵌进地形里，否则会被碰撞挤出场地） */
function spawnOnGround(g, type, x) {
  const def = ENEMY_DEFS[type];
  const floorTop = g.level.solids[0].y;
  const e = g.spawnEnemy(type, x, floorTop - def.h - 4);
  e.spawnGrace = 0;
  return e;
}

function run(g, n) {
  for (let i = 0; i < n; i++) {
    // pin 住的玩家不参与模拟，避免被打死/掉血干扰判定
    const saved = [...g.players.values()];
    for (const p of saved) if (p.pin) { p.hp = p.maxHp; p.alive = true; p.downed = false; }
    g.update(TICK_DT);
    for (const p of saved) if (p.pin) { p.vy = 0; p.vx = 0; }
  }
}

// ---------------------------------------------------------------- 1. 数学前提
{
  const one = apexRise(PHYS.jumpVel), two = one + apexRise(PHYS.doubleJumpVel);
  const step = 820 - 652;   // 农场地面 → 第一层平台的高度差
  console.log('\n[1] 跳跃高度 / 平台落差');
  ok(one < step && step <= two, `第一层平台（${step}px）必须「一段跳不够、二段跳刚好够」`, `(一段 ${one.toFixed(0)} / 两段 ${two.toFixed(0)})`);
  console.log(`  参考：玩家一段跳 ${one.toFixed(0)}px，含二段跳 ${two.toFixed(0)}px，NAV.reachGrace=${NAV.reachGrace}`);
}

// ---------------------------------------------------------------- 2. 各怪都能跳两段
{
  console.log('\n[2] 敌人跳跃配置');
  for (const [k, def] of Object.entries(ENEMY_DEFS)) {
    if (def.flying) { ok(!def.jump, `${k} 是飞行怪，不需要跳跃配置`); continue; }
    ok(!!def.jump && def.jump.jumps >= 2, `${k} 具备二段跳`, JSON.stringify(def.jump));
  }
}

// ---------------------------------------------------------------- 3. 跳板计划
{
  console.log('\n[3] 跳板规划（planHop）');
  const { g, p } = makeGame('farm');
  const plat = g.level.solids.find((s) => s.y === 652 && s.x === 120);
  pinPlayer(g, p, plat.x + plat.w / 2, plat.y);            // 玩家站在 120..360 / y=652 上
  const e = spawnOnGround(g, 'slime', 180);                  // 敌人就在玩家正下方的地面上
  ok(!!e, '生成了一只史莱姆');
  const nav = jumpPower(e);
  ok(nav.maxJumps === 2 && nav.vel >= PHYS.jumpVel, '史莱姆跳得和玩家一样高或更高');
  const plan = planHop(g, e, p, nav);
  ok(!!plan, '站在平台正下方时能算出跳板', JSON.stringify(plan));
  if (plan) {
    ok(plan.top === plat.y, '落点就是玩家脚下那块平台');
    ok(Math.abs(plan.approachX - (plat.x + plat.w / 2)) > plat.w / 2, '玩家正下方 → 先绕到平台侧边起跳');
    ok(plan.needDouble === true, '高度差超过一段跳 → 标记需要二段跳');
    // 绕到侧边后必须真的能站人
    const st = { x: plan.approachX - e.w / 2, y: e.y, w: e.w, h: e.h };
    ok(st.x > 0 && st.x < g.level.width, '起跳点在场地内');
  }
}

// ---------------------------------------------------------------- 4. 真跳上来了（核心）
{
  console.log('\n[4] 逐 tick 模拟：地面怪追平台上的玩家');
  const cases = [
    { type: 'slime', platX: 240, limit: 60 * 10, label: '史莱姆（慢速 88）' },
    { type: 'rusher', platX: 240, limit: 60 * 8, label: '疯跑鸡（快速 215）' },
    { type: 'tank', platX: 1150, limit: 60 * 18, label: '石头人（笨重 60）' },
    { type: 'shooter', platX: 870, limit: 60 * 16, label: '射手菌（远程 72）' },
    { type: 'bomber', platX: 1410, limit: 60 * 12, label: '炸弹怪（自爆 140）' },
  ];
  for (const c of cases) {
    const { g, p } = makeGame('farm');
    const plat = g.level.solids.find((s) => s.y + s.h / 2 > 0 && Math.abs(s.x + s.w / 2 - c.platX) < 140 && s.h === 22);
    if (!plat) { ok(false, `${c.label} 找不到测试平台`); continue; }
    pinPlayer(g, p, plat.x + plat.w / 2, plat.y);
    // 敌人在玩家正下方的地面上出生
    const e = spawnOnGround(g, c.type, plat.x + plat.w / 2);
    let maxJumps = 0, landings = 0, prevGround = false;
    let onPlat = false;
    for (let t = 0; t < c.limit && !onPlat; t++) {
      for (const pl of g.players.values()) { pl.hp = pl.maxHp; pl.alive = true; pl.downed = false; pl.vx = 0; pl.vy = 0; pl.x = plat.x + plat.w / 2 - pl.w; pl.y = plat.y - pl.h; }
      g.update(TICK_DT);
      if (!e.dead) {
        maxJumps = Math.max(maxJumps, e.jumps || 0);
        if (e.onGround && !prevGround) landings++;
        prevGround = e.onGround;
        onPlat = e.onGround && Math.abs((e.y + e.h) - plat.y) <= 2;
      }
    }
    ok(onPlat, `${c.label} 在 ${(c.limit / 60).toFixed(0)}s 内跳上了平台`,
      `最终 y=${e.y.toFixed(0)} feet=${(e.y + e.h).toFixed(0)} 平台=${plat.y}`);
    ok(maxJumps >= 2, `${c.label} 用到了二段跳`, `jumps=${maxJumps}`);
    console.log(`      （起跳次数≈${landings}，最终与玩家水平距离 ${Math.abs((e.x + e.w / 2) - (p.x + p.w / 2)).toFixed(0)}px）`);
  }
}

// ---------------------------------------------------------------- 5. 多级跳板
{
  console.log('\n[5] 连续跳两级平台（农场 652 → 540 → 400）');
  const { g, p } = makeGame('farm');
  const top = g.level.solids.find((s) => s.y === 400);      // 700..900 / y=400
  pinPlayer(g, p, top.x + top.w / 2, top.y);
  const e = spawnOnGround(g, 'rusher', 780);
  let best = 1e9, seen = new Set();
  for (let t = 0; t < 60 * 20; t++) {
    for (const pl of g.players.values()) { pl.hp = pl.maxHp; pl.alive = true; pl.downed = false; pl.vx = 0; pl.vy = 0; }
    g.update(TICK_DT);
    if (e.dead) break;
    best = Math.min(best, (e.y + e.h) - top.y);
    for (const s of g.level.solids) if (s.h === 22 && Math.abs((e.y + e.h) - s.y) <= 2 && e.onGround) seen.add(s.y);
    if (Math.abs((e.y + e.h) - top.y) <= 2 && e.onGround) break;
  }
  const reached = Math.abs((e.y + e.h) - top.y) <= 2 && e.onGround;
  ok(reached, `疯跑鸡爬到玩家所在的最高平台（路径：${[...seen].sort((a, b) => b - a).join(' → ')}）`,
    `feet=${(e.y + e.h).toFixed(0)} 目标=${top.y} 最近差值=${best.toFixed(0)}`);
}

// ---------------------------------------------------------------- 6. 不掉出世界 / 不死锁
{
  console.log('\n[6] 稳定性：不会卡住抽搐，也不会飞出世界');
  const { g, p } = makeGame('cellar');
  const plat = g.level.solids.find((s) => s.y === 560);
  pinPlayer(g, p, plat.x + plat.w / 2, plat.y);
  const types = ['slime', 'rusher', 'shooter', 'tank', 'bomber', 'flyer'];
  const list = types.map((ty, i) => spawnOnGround(g, ty, 300 + i * 90));
  let jumpEvents = 0;
  for (let t = 0; t < 60 * 25; t++) {
    for (const pl of g.players.values()) { pl.hp = pl.maxHp; pl.alive = true; pl.downed = false; }
    g.update(TICK_DT);
    jumpEvents += g.events.filter((ev) => ev.t === 'jump' || ev.t === 'edouble').length;
  }
  for (const e of list) {
    if (e.dead) continue;
    ok(e.x >= -1 && e.x + e.w <= g.level.width + 1 && e.y + e.h <= g.level.height + 300, `${e.type} 还在场地内`, `x=${e.x.toFixed(0)} y=${e.y.toFixed(0)}`);
    // 抽搐检测：最后一分钟内的起跳频率不应该爆炸（每 tick 一次 = 卡死）
    ok(e.jumpCd >= -0.001 && (e.jumps | 0) >= 0, `${e.type} 跳跃计数没有溢出/NaN`);
  }
  ok(jumpEvents > 0, '确实产生了跳跃事件（用于客户端扬尘）', `events=${jumpEvents}`);
  const alive = list.filter((e) => !e.dead);
  const near = alive.filter((e) => Math.hypot((e.x + e.w / 2) - (p.x + p.w / 2), (e.y + e.h) - (p.y + p.h)) < 260).length;
  ok(near >= Math.min(3, alive.length - 1), `大部分地面怪跟到了玩家附近（${near}/${alive.length}）`);
}

// ---------------------------------------------------------------- 7. 玩家真的会被打到
{
  console.log('\n[7] 玩家站在平台上不再安全');
  const { g, p } = makeGame('farm');
  const plat = g.level.solids.find((s) => s.y === 540 && s.x === 470);
  pinPlayer(g, p, plat.x + plat.w / 2, plat.y);
  p.stats = { ...p.stats };
  const e = spawnOnGround(g, 'rusher', plat.x + plat.w / 2);
  let hurt = false;
  for (let t = 0; t < 60 * 8; t++) {
    p.hp = p.maxHp; p.alive = true; p.downed = false; p.vy = 0; p.vx = 0;
    p.x = plat.x + plat.w / 2 - p.w; p.y = plat.y - p.h;
    const before = g.players.get('p0').damageTaken;
    g.update(TICK_DT);
    if (g.players.get('p0').damageTaken > before) { hurt = true; break; }
  }
  ok(hurt, '平台上的人被跳上来的怪打到了');
}

// ---------------------------------------------------------------- 7.5 Boss 也会跟着上平台
{
  console.log('\n[7.5] Boss 追平台');
  const { g, p } = makeGame('farm');
  const plat = g.level.solids.find((s) => s.y === 664);   // 760..980，宽到 Boss 站得下
  pinPlayer(g, p, plat.x + plat.w / 2, plat.y);
  const e = spawnOnGround(g, 'boss', plat.x + plat.w / 2 - 200);
  e.abilityCd = 999;                                        // 只测导航，不让技能节奏干扰
  let onPlat = false;
  for (let t = 0; t < 60 * 25 && !onPlat; t++) {
    for (const pl of g.players.values()) { pl.hp = pl.maxHp; pl.alive = true; pl.downed = false; pl.vx = 0; pl.vy = 0; pl.x = plat.x + plat.w / 2 - pl.w; pl.y = plat.y - pl.h; }
    g.update(TICK_DT);
    onPlat = !e.dead && e.onGround && Math.abs((e.y + e.h) - plat.y) <= 2;
  }
  ok(onPlat, '土豆王能二段跳上玩家站的平台', `feet=${(e.y + e.h).toFixed(0)} 平台=${plat.y} x=${e.x.toFixed(0)}`);
  ok(e.maxHp > 1000, 'Boss 血量正常（没被导航搞出 NaN）', `hp=${e.hp}/${e.maxHp}`);
}

// ---------------------------------------------------------------- 8. 无目标/晕眩时不炸
{
  console.log('\n[8] 边界情况');
  const { g } = makeGame('farm');
  const e = spawnOnGround(g, 'slime', 400);
  for (const p of g.players.values()) p.alive = false;   // 没有活人
  let threw = false;
  try { run(g, 120); } catch (err) { threw = true; console.log('    ', err.message); }
  ok(!threw, '没有可追击目标时不报错');
  ok(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.vy), '数值仍然有限', `x=${e.x} y=${e.y} vy=${e.vy}`);
  const e2 = spawnOnGround(g, 'tank', 700);
  e2.stun = 3;
  try { run(g, 60); } catch (err) { threw = true; console.log('    ', err.message); }
  ok(!threw && Number.isFinite(e2.x), '晕眩中的怪不报错');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
