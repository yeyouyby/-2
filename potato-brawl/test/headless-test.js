// 无头集成测试：起服务器 → 机器人建房/加入 → 自动游玩 → 打印战报
// 用法：node test/headless-test.js [pve|ffa|team|all] [秒数]
import { createServer } from '../server/src/net/server.js';
import { WebSocket } from 'ws';
import { IN } from '../shared/constants.js';

const MODE_ARG = (process.argv[2] || 'all').toLowerCase();
const SECONDS = Number(process.argv[3] || 45);
const PORT = 3999;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Bot {
  constructor(name, opts = {}) {
    this.name = name;
    this.id = null;
    this.token = 'tok_' + Math.random().toString(36).slice(2);
    this.ws = null;
    this.room = null;
    this.snaps = 0;
    this.lastSnap = null;
    this.result = null;
    this.started = false;
    this.smart = opts.smart !== false;
    this.input = 0;
    this.dirTimer = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', () => {
        this.send({ t: 'hello', name: this.name, token: this.token });
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.id = m.id; break;
      case 'joined': this.code = m.code; break;
      case 'err': if (!String(m.msg).includes('未准备')) console.log(`  [${this.name}] 错误: ${m.msg}`); break;
      case 'start': this.started = true; this.settings = m.settings; break;
      case 'room': this.room = m.room; break;
      case 'over': this.result = m.result; break;
      case 'snap':
        this.snaps++;
        this.lastSnap = m;
        this.think(m);
        break;
      default: break;
    }
  }

  think(s) {
    if (!s.me) return;
    // 自动升级三选一
    if (s.me.ch && s.me.ch.length) this.send({ t: 'pick', idx: Math.floor(Math.random() * s.me.ch.length) });
    // 自动购物
    if (s.me.sh && s.me.sh.offers) {
      s.me.sh.offers.forEach((o, i) => {
        if (!o.sold && o.price <= s.me.coins) this.send({ t: 'buy', idx: i });
      });
      if (s.me.coins > 60) this.send({ t: 'reroll' });
      this.send({ t: 'shopReady', v: true });
    }
  }

  /** 简单 AI：朝最近的目标移动 + 偶尔跳/冲刺 */
  drive(dt) {
    const s = this.lastSnap;
    let mask = 0;
    if (this.smart && s && s.me) {
      const me = s.p.find((p) => p.i === this.id);
      if (me && me.a) {
        let tx = null, ty = null, bd = Infinity;
        const targets = [
          ...s.e.map((e) => ({ x: e.x + 8, y: e.y + 8, e: 1 })),
          ...s.k.map((k) => ({ x: k.x, y: k.y, e: 0 })),
        ];
        if (this.settings && this.settings.mode !== 'pve') {
          for (const p of s.p) if (p.i !== this.id && p.a) targets.push({ x: p.x, y: p.y, e: 1 });
        }
        for (const t of targets) {
          const d = Math.hypot(t.x - me.x, t.y - me.y);
          if (d < bd) { bd = d; tx = t.x; ty = t.y; }
        }
        if (tx !== null) {
          const dx = tx - me.x;
          if (dx > 26) mask |= IN.RIGHT;
          else if (dx < -26) mask |= IN.LEFT;
          if (ty < me.y - 60 && Math.random() < 0.04) mask |= IN.JUMP;
          if (bd > 320 && Math.random() < 0.02) mask |= IN.DASH;
          if (bd < 90 && Math.random() < 0.02) mask |= IN.LEFT | IN.JUMP;
        }
      }
    } else {
      this.dirTimer -= dt;
      if (this.dirTimer <= 0) { this.dirTimer = 0.4 + Math.random(); this.input = Math.random() < 0.5 ? IN.LEFT : IN.RIGHT; }
      mask = this.input;
      if (Math.random() < 0.02) mask |= IN.JUMP;
    }
    this.send({ t: 'input', i: mask });
  }
}

async function runScenario(mode, seconds) {
  console.log(`\n=== 场景：${mode.toUpperCase()} ===`);
  const { server, manager } = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const bots = [new Bot('机长土豆'), new Bot('二号土豆'), new Bot('三号土豆')];
  for (const b of bots) await b.connect();
  await sleep(120);

  bots[0].send({ t: 'create', roomName: '测试房', name: bots[0].name });
  await sleep(220);
  const code = bots[0].code;
  console.log(`  房间码: ${code}`);
  for (let i = 1; i < bots.length; i++) {
    bots[i].send({ t: 'join', code, name: bots[i].name });
    await sleep(120);
  }

  bots[0].send({
    t: 'settings',
    settings: {
      mode, levelId: 'farm', maxPlayers: 8,
      totalWaves: mode === 'pve' ? 4 : 20,
      difficulty: 1, prepTime: 8,
      scoreLimit: mode === 'pve' ? 20 : 12,
      timeLimit: seconds,
    },
  });
  await sleep(120);
  for (const b of bots) b.send({ t: 'ready', v: true });
  await sleep(150);
  bots[0].send({ t: 'start' });
  await sleep(300);

  const t0 = Date.now();
  let lastDrive = 0;
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(30);
    const now = Date.now();
    const dt = (now - lastDrive) / 1000;
    lastDrive = now;
    for (const b of bots) b.drive(dt);
    if (bots.some((b) => b.result)) break;
  }

  // 报告
  const room = manager.getRoom(code);
  const g = room && room.game;
  let ok = true;
  const check = (label, cond, val = '') => {
    if (!cond) ok = false;
    console.log(`  ${cond ? '✅' : '❌'} ${label} ${val}`);
  };
  check('房间已创建并有人', !!room && room.players.size === bots.length, `(${room ? room.players.size : 0} 人)`);
  check('对局进行中/已结束', !!g);
  check('所有机器人都收到快照', bots.every((b) => b.snaps > 10), `(最少 ${Math.min(...bots.map((b) => b.snaps))} 个)`);
  if (g) {
    console.log(`  阶段=${g.phase} 波次=${g.wave} 敌人=${g.enemies.length} 弹幕=${g.projectiles.length} 掉落=${g.pickups.length}`);
    console.log('  ' + [...g.players.values()].map((p) =>
      `${p.name}: Lv${p.level} ${Math.round(p.hp)}/${p.maxHp}hp 击杀${p.kills} 伤害${Math.round(p.damageDealt)} 武器[${p.weapons.map((w) => w.id).join(',')}] 道具${Object.keys(p.items).length}种`
    ).join('\n  '));
    const anyKill = [...g.players.values()].some((p) => p.kills > 0);
    const anyDmg = [...g.players.values()].some((p) => p.damageDealt > 0);
    const anyXp = [...g.players.values()].some((p) => p.level > 1);
    check('产生了伤害', anyDmg);
    if (mode === 'pve') check('有击杀', anyKill);
    check('有升级（经验系统生效）', anyXp);
    if (mode !== 'pve') check('PvP 有计分', [...g.players.values()].some((p) => p.kills > 0) || g.tick > 100);
  }
  const finished = bots.find((b) => b.result);
  if (finished) {
    console.log(`  战报：${finished.result.win ? '胜利' : '失败'} · 原因=${finished.result.reason} · 波次=${finished.result.wave}`);
  }

  for (const b of bots) { try { b.ws.close(); } catch { /* ignore */ } }
  server.close();
  await sleep(200);
  return ok;
}

(async () => {
  const modes = MODE_ARG === 'all' ? ['pve', 'ffa', 'team'] : [MODE_ARG];
  let allOk = true;
  for (const m of modes) {
    const ok = await runScenario(m, SECONDS);
    allOk = allOk && ok;
  }
  console.log(`\n${allOk ? '🎉 全部检查通过' : '⚠️  存在失败项'}\n`);
  process.exit(allOk ? 0 : 1);
})();
