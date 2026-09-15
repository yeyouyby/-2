// 用无头浏览器打开游戏，模拟两个玩家进入对局并截图（仅用于开发自检）
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000';
const SHOT_DIR = '/home/user/potato-brawl/test/shots';

async function playerPage(browser, name, idx) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#inp-name', name);
  return { page, errors, ctx };
}

const run = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const a = await playerPage(browser, '土豆一号', 0);
  await a.page.waitForTimeout(600);
  await a.page.screenshot({ path: `${SHOT_DIR}/01-home.png` });

  await a.page.click('#btn-create');
  await a.page.waitForTimeout(700);
  await a.page.screenshot({ path: `${SHOT_DIR}/02-lobby.png` });
  const code = await a.page.textContent('#lobby-code');
  console.log('房间码:', code);

  const b = await playerPage(browser, '土豆二号', 1);
  await b.page.fill('#inp-code', code.trim());
  await b.page.click('#btn-join');
  await b.page.waitForTimeout(600);
  await b.page.screenshot({ path: `${SHOT_DIR}/03-lobby2.png` });

  await a.page.click('#btn-ready');
  await b.page.click('#btn-ready');
  await a.page.waitForTimeout(400);
  await a.page.click('#btn-start');
  await a.page.waitForTimeout(1200);
  await a.page.screenshot({ path: `${SHOT_DIR}/04-game-start.png` });

  // 模拟操作：移动 + 跳跃
  const keys = ['KeyD', 'KeyA', 'Space', 'KeyD', 'Space', 'ShiftLeft'];
  for (let i = 0; i < 60; i++) {
    const k = keys[i % keys.length];
    await a.page.keyboard.down(k);
    await a.page.waitForTimeout(120);
    await a.page.keyboard.up(k);
    if (i === 20) await a.page.screenshot({ path: `${SHOT_DIR}/05-game-play.png` });
    if (i === 40) await a.page.screenshot({ path: `${SHOT_DIR}/06-game-play2.png` });
  }
  await a.page.screenshot({ path: `${SHOT_DIR}/07-game-late.png` });

  const info = await a.page.evaluate(() => ({
    ping: window.PB ? window.PB.net.ping : -1,
    phase: window.PB ? window.PB.game.phase : 'n/a',
    wave: window.PB ? window.PB.game.wave : -1,
    players: window.PB ? window.PB.game.view.players.length : -1,
    enemies: window.PB ? window.PB.game.view.enemies.length : -1,
    particles: window.PB ? window.PB.game.particles.length : -1,
    hp: window.PB && window.PB.game.pred ? Math.round(window.PB.game.pred.x) : -1,
  }));
  console.log('运行时状态:', JSON.stringify(info));

  // 计分板 + 属性面板
  await a.page.keyboard.press('Tab');
  await a.page.waitForTimeout(250);
  await a.page.screenshot({ path: `${SHOT_DIR}/08-scoreboard.png` });

  console.log('A 控制台错误:', a.errors.length ? a.errors.slice(0, 8) : '无');
  console.log('B 控制台错误:', b.errors.length ? b.errors.slice(0, 8) : '无');
  await browser.close();
  process.exit(a.errors.length || b.errors.length ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(2); });
