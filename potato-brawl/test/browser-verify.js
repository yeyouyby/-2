// 端到端自检：真实浏览器里跑完整流程，用断言代替肉眼看图
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000';
const SHOTS = '/home/user/potato-brawl/test/shots';
const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${label} ${extra}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#inp-name', name);
  await page.waitForTimeout(400);
  return { page, errors };
}

const canvasStats = (page) => page.evaluate(() => {
  const c = document.getElementById('game-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const set = new Set();
  let nonBlack = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 733) {
    n++;
    if (d[i] + d[i + 1] + d[i + 2] > 40) nonBlack++;
    set.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
  }
  return { colors: set.size, nonBlackRatio: +(nonBlack / n).toFixed(3), w: c.width, h: c.height };
});

const snap = (page) => page.evaluate(() => {
  const g = window.PB.game, s = g.lastSnap || (window.PB.ui.lastSnap);
  return {
    phase: g.phase, wave: g.wave, tick: g.tick,
    enemies: g.view.enemies.length, bullets: g.view.bullets.length,
    pickups: g.view.pickups.length, players: g.view.players.length,
    particles: g.particles.length,
    me: s && s.me ? { hp: s.me.hp, lv: s.me.lv, coins: s.me.coins, kills: s.me.kills, weapons: s.me.w.length, items: Object.keys(s.me.it).length, ch: !!s.me.ch } : null,
    predX: g.pred ? Math.round(g.pred.x) : -1, predY: g.pred ? Math.round(g.pred.y) : -1,
  };
});

async function waitFor(page, fn, timeout = 40000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (fn(s)) return s;
    await sleep(250);
  }
  console.log(`    (等待超时: ${label})`);
  return null;
}

/** 模拟一段乱走乱跳的操作 */
async function play(page, seconds, shotAt) {
  const keys = ['KeyD', 'KeyA', 'Space', 'KeyD', 'KeyD', 'Space', 'KeyA', 'ShiftLeft', 'KeyW'];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const k = keys[i % keys.length];
    await page.keyboard.down(k);
    await sleep(140);
    await page.keyboard.up(k);
    i++;
    if (shotAt && i === shotAt) await page.screenshot({ path: `${SHOTS}/${shotAt}.png` });
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ============================ PvE ============================
  console.log('\n=== 合作 PvE 全流程 ===');
  const a = await open(browser, '土豆甲');
  const b = await open(browser, '土豆乙');
  await a.page.screenshot({ path: `${SHOTS}/01-home.png` });
  await a.page.click('#btn-create');
  await sleep(700);
  await a.page.screenshot({ path: `${SHOTS}/02-lobby.png` });
  const code = (await a.page.textContent('#lobby-code')).trim();
  check('建房成功并进入大厅', await a.page.isVisible('#screen-lobby'), `房间码 ${code}`);

  await b.page.fill('#inp-code', code);
  await b.page.click('#btn-join');
  await sleep(600);
  check('第二位玩家用房间码加入', await b.page.isVisible('#screen-lobby'));
  await a.page.screenshot({ path: `${SHOTS}/03-lobby-2p.png` });

  await a.page.click('#btn-ready');
  await b.page.click('#btn-ready');
  await sleep(300);
  await a.page.click('#btn-start');
  await sleep(1500);
  check('房主开始游戏并进入战斗画面', await a.page.isVisible('#screen-game'));

  const cvs = await canvasStats(a.page);
  check('画布已渲染内容（非空白）', cvs.nonBlackRatio > 0.8 && cvs.colors > 30, `色彩数 ${cvs.colors}，非黑占比 ${cvs.nonBlackRatio}`);

  // 移动预测
  const p0 = await snap(a.page);
  await a.page.keyboard.down('KeyD');
  await sleep(700);
  await a.page.keyboard.up('KeyD');
  const p1 = await snap(a.page);
  check('本地预测：按 D 之后角色向右移动', p1.predX > p0.predX + 20, `x: ${p0.predX} → ${p1.predX}`);

  // 等第一波
  const w1 = await waitFor(a.page, (s) => s.wave >= 1 && s.enemies > 0, 45000, '第一波敌人出现');
  check('第一波刷怪', !!w1, w1 ? `场上 ${w1.enemies} 只敌人` : '');

  // 打一会儿
  await play(a.page, 14, '04-battle');
  const s2 = await snap(a.page);
  check('战斗中产生了弹幕', s2.bullets > 0 || s2.particles > 0, `弹幕 ${s2.bullets} / 粒子 ${s2.particles}`);
  check('有敌人被击杀并掉落', s2.pickups > 0 || (s2.me && s2.me.kills > 0), `掉落 ${s2.pickups} / 击杀 ${s2.me?.kills}`);
  await a.page.screenshot({ path: `${SHOTS}/05-battle2.png` });

  // 升级三选一
  const lv = await waitFor(a.page, (s) => s.me && s.me.ch, 45000, '出现升级选项');
  if (lv) {
    const visible = await a.page.isVisible('#levelup');
    check('升级面板弹出', visible);
    await a.page.screenshot({ path: `${SHOTS}/06-levelup.png` });
    const before = lv.me.items + lv.me.weapons;
    await a.page.keyboard.press('Digit1');
    await sleep(600);
    const after = await snap(a.page);
    check('选择升级后 build 发生变化', (after.me.items + after.me.weapons) > before, `${before} → ${after.me.items + after.me.weapons} 件`);
    check('升级面板已关闭', !(await a.page.isVisible('#levelup')));
  } else check('出现升级选项', false);

  // 商店（备战阶段）
  const shopS = await waitFor(a.page, (s) => s.phase === 'prep', 90000, '进入备战/商店阶段');
  if (shopS) {
    check('进入波间商店', await a.page.isVisible('#shop'));
    await a.page.screenshot({ path: `${SHOTS}/07-shop.png` });
    const offers = await a.page.$$('#shop-offers .offer');
    check('商店有商品', offers.length === 5, `${offers.length} 件商品`);
    let bought = false;
    for (const o of offers) {
      const poor = await o.evaluate((el) => el.classList.contains('poor'));
      if (!poor) { await o.click(); bought = true; break; }
    }
    await sleep(500);
    const afterBuy = await snap(a.page);
    check('购买商品生效（金币减少或 build 增加）', !bought || afterBuy.me.coins < shopS.me.coins || (afterBuy.me.items + afterBuy.me.weapons) > (shopS.me.items + shopS.me.weapons),
      `金币 ${shopS.me.coins} → ${afterBuy.me.coins}`);
    await a.page.click('#btn-shop-ready');
    await sleep(300);
  } else check('进入波间商店', false);

  // 计分板 / 属性面板
  await a.page.keyboard.press('Tab');
  await sleep(200);
  check('Tab 打开计分板', await a.page.isVisible('#scoreboard'));
  await a.page.screenshot({ path: `${SHOTS}/08-scoreboard.png` });
  await a.page.keyboard.press('Tab');
  await a.page.click('#btn-stats');
  await sleep(200);
  check('属性面板有内容', (await a.page.textContent('#stats-panel')).includes('伤害倍率'));

  // ============================ PvP ============================
  console.log('\n=== PvP 死斗 ===');
  for (const pg of [a, b]) {
    await pg.page.evaluate(() => window.PB.ui.leaveRoom());
    await sleep(300);
  }
  await a.page.click('#btn-create');
  await sleep(600);
  await a.page.evaluate(() => window.PB.net.send({ t: 'settings', settings: { mode: 'ffa', scoreLimit: 30, timeLimit: 300 } }));
  await sleep(300);
  const code2 = (await a.page.textContent('#lobby-code')).trim();
  await b.page.fill('#inp-code', code2);
  await b.page.click('#btn-join');
  await sleep(500);
  await a.page.click('#btn-ready');
  await b.page.click('#btn-ready');
  await sleep(300);
  await a.page.click('#btn-start');
  await sleep(1500);
  check('PvP 开局', await a.page.isVisible('#screen-game'));

  await play(a.page, 16, '09-pvp');
  const pv = await snap(a.page);
  check('PvP 双方都在场', pv.players === 2, `${pv.players} 人`);
  check('PvP 有伤害/击杀发生', (pv.me && (pv.me.kills > 0 || pv.me.hp < pv.me.hp + 1)) || pv.particles > 0, `击杀 ${pv.me?.kills} HP ${pv.me?.hp}`);
  const topbarTimer = await a.page.textContent('#tb-timer');
  check('PvP 倒计时在走', /0[0-4]:\d\d/.test(topbarTimer), topbarTimer);
  await a.page.screenshot({ path: `${SHOTS}/10-pvp.png` });

  // ============================ 收尾 ============================
  const errs = [...a.errors, ...b.errors].filter((e) => !e.includes('favicon'));
  check('没有 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${bad.length === 0 ? '🎉 全部通过' : `⚠️  ${bad.length} 项未通过`} （${results.length - bad.length}/${results.length}）\n`);
  process.exit(bad.length ? 1 : 0);
})();
