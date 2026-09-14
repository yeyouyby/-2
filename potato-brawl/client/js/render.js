// Canvas 渲染：全部程序化绘制（不依赖任何图片素材）
import { ENEMY_DEFS } from '/shared/enemies.js';
import { weaponById } from '/shared/weapons.js';

const TAU = Math.PI * 2;

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export class Renderer {
  constructor(game) {
    this.g = game;
    this.canvas = game.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.time = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const c = this.canvas;
    this.w = c.clientWidth || window.innerWidth;
    this.h = c.clientHeight || window.innerHeight;
    c.width = Math.floor(this.w * this.dpr);
    c.height = Math.floor(this.h * this.dpr);
  }

  /** 计算相机：整块竞技场铺满屏幕（保持比例） */
  camera(level) {
    const s = Math.min(this.w / level.width, this.h / level.height);
    return {
      scale: s,
      ox: (this.w - level.width * s) / 2,
      oy: (this.h - level.height * s) / 2,
    };
  }

  draw(dt) {
    const g = this.g;
    const ctx = this.ctx;
    this.time += dt;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const level = g.level;
    const cam = this.camera(level);
    let sx = 0, sy = 0;
    if (g.shake > 0) {
      sx = (Math.random() - 0.5) * g.shake;
      sy = (Math.random() - 0.5) * g.shake;
    }
    ctx.save();
    ctx.translate(cam.ox + sx, cam.oy + sy);
    ctx.scale(cam.scale, cam.scale);

    this.drawBackground(level);
    this.drawSolids(level);
    this.drawPickups();
    this.drawPortals();
    this.drawEnemies();
    this.drawPlayers();
    this.drawBullets();
    this.drawBeams();
    this.drawParticles();
    this.drawWorldUI();

    ctx.restore();

    // 屏幕边缘暗角
    const vg = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.w, this.h);

    if (g.hurtFlash > 0) {
      ctx.fillStyle = `rgba(255,40,40,${Math.min(0.35, g.hurtFlash)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  // ------------------------------------------------------------ 背景
  drawBackground(level) {
    const ctx = this.ctx;
    const sky = level.sky;
    const grd = ctx.createLinearGradient(0, 0, 0, level.height);
    grd.addColorStop(0, sky[0]);
    grd.addColorStop(0.55, sky[1]);
    grd.addColorStop(1, sky[2]);
    ctx.fillStyle = grd;
    ctx.fillRect(-200, -200, level.width + 400, level.height + 400);

    // 太阳 / 月亮
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath();
    ctx.arc(level.width * 0.8, level.height * 0.22, 70, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 远山
    ctx.fillStyle = 'rgba(20,26,40,0.55)';
    ctx.beginPath();
    ctx.moveTo(-100, level.height * 0.72);
    for (let i = 0; i <= 8; i++) {
      const x = -100 + (level.width + 200) * (i / 8);
      const y = level.height * 0.72 - Math.sin(i * 1.7) * 70 - 40;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(level.width + 100, level.height);
    ctx.lineTo(-100, level.height);
    ctx.fill();

    // 云
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) {
      const x = ((this.time * (8 + i * 3) + i * 420) % (level.width + 300)) - 150;
      const y = 90 + i * 55;
      this.cloud(x, y, 46 + i * 9);
    }
    ctx.restore();
  }

  cloud(x, y, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, s * 0.5, 0, TAU);
    ctx.arc(x + s * 0.45, y + s * 0.1, s * 0.36, 0, TAU);
    ctx.arc(x - s * 0.45, y + s * 0.12, s * 0.32, 0, TAU);
    ctx.arc(x + s * 0.1, y - s * 0.28, s * 0.32, 0, TAU);
    ctx.fill();
  }

  drawSolids(level) {
    const ctx = this.ctx;
    for (const s of level.solids) {
      if (s.h >= 80) {
        // 地面
        const grd = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
        grd.addColorStop(0, level.groundTop || '#8fbe57');
        grd.addColorStop(0.14, level.groundTop || '#8fbe57');
        grd.addColorStop(0.16, level.ground);
        grd.addColorStop(1, '#2a1f16');
        ctx.fillStyle = grd;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = 'rgba(0,0,0,.18)';
        for (let x = s.x; x < s.x + s.w; x += 46) ctx.fillRect(x + 6, s.y + 22, 34, 5);
      } else {
        // 浮空平台：木板
        ctx.fillStyle = 'rgba(0,0,0,.25)';
        rr(ctx, s.x + 3, s.y + 5, s.w, s.h, 6); ctx.fill();
        const grd = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
        grd.addColorStop(0, '#c98f4e');
        grd.addColorStop(0.5, '#a2703a');
        grd.addColorStop(1, '#6d4a26');
        ctx.fillStyle = grd;
        rr(ctx, s.x, s.y, s.w, s.h, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.3)';
        ctx.lineWidth = 1.5;
        for (let x = s.x + 18; x < s.x + s.w - 8; x += 34) {
          ctx.beginPath(); ctx.moveTo(x, s.y + 2); ctx.lineTo(x, s.y + s.h - 2); ctx.stroke();
        }
        // 顶部草/苔
        ctx.fillStyle = 'rgba(143,190,87,.85)';
        rr(ctx, s.x, s.y - 3, s.w, 6, 3); ctx.fill();
      }
    }
  }

  drawPortals() {
    const g = this.g;
    const ctx = this.ctx;
    for (const p of g.portals) {
      const a = p.life / p.max;
      ctx.save();
      ctx.globalAlpha = a * 0.7;
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 30 * (1.4 - a * 0.4), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = a * 0.25;
      ctx.fillStyle = '#ff6b6b';
      ctx.fill();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ 实体
  drawPickups() {
    const ctx = this.ctx;
    for (const k of this.g.view.pickups) {
      const bob = Math.sin(this.time * 6 + k.i) * 2;
      ctx.save();
      ctx.translate(k.x, k.y + bob);
      if (k.t === 'xp') {
        ctx.fillStyle = '#4dd4ac';
        ctx.shadowColor = '#4dd4ac'; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, -6); ctx.lineTo(5, 0); ctx.lineTo(0, 6); ctx.lineTo(-5, 0);
        ctx.closePath(); ctx.fill();
      } else if (k.t === 'coin') {
        ctx.fillStyle = '#ffc857';
        ctx.shadowColor = '#ffc857'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.3)';
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
      } else if (k.t === 'heal') {
        ctx.fillStyle = '#ff6b6b';
        ctx.shadowColor = '#ff6b6b'; ctx.shadowBlur = 12;
        rr(ctx, -8, -3, 16, 6, 2); ctx.fill();
        rr(ctx, -3, -8, 6, 16, 2); ctx.fill();
      } else if (k.t === 'crate') {
        ctx.rotate(Math.sin(this.time * 3) * 0.08);
        ctx.fillStyle = '#b98b52';
        rr(ctx, -12, -12, 24, 24, 4); ctx.fill();
        ctx.strokeStyle = '#6d4a26'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(-12, -12); ctx.lineTo(12, 12); ctx.moveTo(12, -12); ctx.lineTo(-12, 12); ctx.stroke();
        ctx.shadowColor = '#ffc857'; ctx.shadowBlur = 14;
        ctx.strokeStyle = '#ffc857'; ctx.lineWidth = 2;
        rr(ctx, -13, -13, 26, 26, 5); ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawEnemies() {
    const ctx = this.ctx;
    for (const e of this.g.view.enemies) {
      const def = ENEMY_DEFS[e.t] || ENEMY_DEFS.slime;
      const w = def.w, h = def.h;
      const x = e.x, y = e.y;
      const flash = e.hf > 0;
      ctx.save();
      ctx.translate(x + w / 2, y + h);
      // 影子
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(0, 2, w * 0.45, 5, 0, 0, TAU); ctx.fill();
      ctx.translate(-w / 2, -h);
      if (flash) ctx.globalAlpha = 1;
      switch (e.t) {
        case 'slime': this.artSlime(w, h, def.color, e, flash); break;
        case 'rusher': this.artRusher(w, h, def.color, e, flash); break;
        case 'flyer': this.artFlyer(w, h, def.color, e, flash); break;
        case 'shooter': this.artShooter(w, h, def.color, e, flash); break;
        case 'tank': this.artTank(w, h, def.color, e, flash); break;
        case 'bomber': this.artBomber(w, h, def.color, e, flash); break;
        case 'boss': this.artBoss(w, h, def.color, e, flash); break;
        default: this.artSlime(w, h, def.color, e, flash);
      }
      ctx.restore();
      // 血条（受伤后或精英/boss 常显）
      if (e.hp < e.mx && (e.el || def.boss || e.hf > 0)) {
        this.bar(x + w / 2, y - 8, Math.max(28, w), 5, e.hp / e.mx, def.boss ? '#ff4d4d' : '#ff8787');
      }
    }
  }

  artSlime(w, h, color, e, flash) {
    const ctx = this.ctx;
    const sq = 1 + Math.sin(this.time * 8 + e.i) * 0.12;
    ctx.fillStyle = flash ? '#ffffff' : color;
    ctx.beginPath();
    ctx.ellipse(w / 2, h - (h / sq) / 2, w / 2 * (2 - sq), (h / sq) / 2, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.beginPath(); ctx.ellipse(w * 0.36, h * 0.32, w * 0.12, h * 0.1, -0.4, 0, TAU); ctx.fill();
    this.eyes(w * 0.38, h * 0.45, w * 0.26, e.f, 3.5, flash);
  }

  artRusher(w, h, color, e, flash) {
    const ctx = this.ctx;
    const legPhase = Math.sin(this.time * 22) * 5;
    ctx.strokeStyle = flash ? '#fff' : '#e8a15a'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 4, h - 6); ctx.lineTo(w / 2 - 4 + legPhase, h);
    ctx.moveTo(w / 2 + 4, h - 6); ctx.lineTo(w / 2 + 4 - legPhase, h);
    ctx.stroke();
    ctx.fillStyle = flash ? '#ffffff' : color;
    ctx.beginPath();
    ctx.moveTo(w / 2, 2); ctx.lineTo(w - 2, h * 0.55); ctx.lineTo(w / 2, h - 6); ctx.lineTo(2, h * 0.55);
    ctx.closePath(); ctx.fill();
    // 鸡冠 + 喙
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath(); ctx.arc(w / 2, 3, 4, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#ffb03a';
    const fx = e.f >= 0 ? w - 2 : 2;
    ctx.beginPath();
    ctx.moveTo(fx, h * 0.5); ctx.lineTo(fx + (e.f >= 0 ? 7 : -7), h * 0.56); ctx.lineTo(fx, h * 0.62);
    ctx.closePath(); ctx.fill();
    this.eyes(w * 0.4, h * 0.42, w * 0.2, e.f, 2.6, flash);
  }

  artFlyer(w, h, color, e, flash) {
    const ctx = this.ctx;
    const flap = Math.sin(this.time * 26 + e.i) * 0.9;
    ctx.fillStyle = 'rgba(120,190,255,.75)';
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(w / 2 + s * w * 0.28, h * 0.45);
      ctx.rotate(s * flap);
      ctx.beginPath(); ctx.ellipse(0, 0, w * 0.34, h * 0.22, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = flash ? '#ffffff' : color;
    ctx.beginPath(); ctx.ellipse(w / 2, h * 0.55, w * 0.3, h * 0.36, 0, 0, TAU); ctx.fill();
    this.eyes(w * 0.42, h * 0.5, w * 0.18, e.f, 2.4, flash);
  }

  artShooter(w, h, color, e, flash) {
    const ctx = this.ctx;
    ctx.fillStyle = flash ? '#ffffff' : '#f1e4d3';
    rr(ctx, w * 0.3, h * 0.45, w * 0.4, h * 0.55, 4); ctx.fill();
    ctx.fillStyle = flash ? '#ffffff' : color;
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.42, w * 0.48, h * 0.36, 0, Math.PI, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(w * (0.3 + i * 0.2), h * (0.22 + (i % 2) * 0.1), 3.5, 0, TAU);
      ctx.fill();
    }
    this.eyes(w * 0.38, h * 0.55, w * 0.24, e.f, 3, flash);
  }

  artTank(w, h, color, e, flash) {
    const ctx = this.ctx;
    ctx.fillStyle = flash ? '#ffffff' : color;
    rr(ctx, 1, h * 0.12, w - 2, h * 0.88, 9); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath();
    ctx.moveTo(w * 0.25, h * 0.3); ctx.lineTo(w * 0.45, h * 0.52); ctx.lineTo(w * 0.3, h * 0.7);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = flash ? '#ffffff' : '#8d99ae';
    rr(ctx, -3, h * 0.35, w * 0.22, h * 0.3, 4); ctx.fill();
    rr(ctx, w * 0.78, h * 0.35, w * 0.22, h * 0.3, 4); ctx.fill();
    this.eyes(w * 0.36, h * 0.32, w * 0.28, e.f, 4, flash);
  }

  artBomber(w, h, color, e, flash) {
    const ctx = this.ctx;
    const fusing = e.ph === 1;
    const pulse = fusing ? 0.5 + Math.abs(Math.sin(this.time * 22)) * 0.5 : 1;
    ctx.fillStyle = fusing ? `rgba(255,${80 + 120 * (1 - pulse)},60,1)` : (flash ? '#ffffff' : '#343a40');
    ctx.beginPath(); ctx.arc(w / 2, h * 0.6, w * 0.42, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.2);
    ctx.quadraticCurveTo(w * 0.75, h * 0.08, w * 0.66, h * 0.02);
    ctx.stroke();
    if (fusing) {
      ctx.fillStyle = '#fff3bf';
      ctx.beginPath(); ctx.arc(w * 0.66, 0, 4 * pulse, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.beginPath(); ctx.arc(w * 0.34, h * 0.45, 4, 0, TAU); ctx.fill();
    this.eyes(w * 0.34, h * 0.62, w * 0.3, e.f, 3.4, flash);
  }

  artBoss(w, h, color, e, flash) {
    const ctx = this.ctx;
    const breathe = 1 + Math.sin(this.time * 2.4) * 0.03;
    ctx.save();
    ctx.translate(w / 2, h);
    ctx.scale(breathe, 1 / breathe);
    ctx.translate(-w / 2, -h);
    ctx.fillStyle = flash ? '#ffffff' : color;
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.6, w * 0.46, h * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.beginPath(); ctx.ellipse(w * 0.32, h * 0.72, w * 0.08, h * 0.05, 0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(w * 0.7, h * 0.66, w * 0.06, h * 0.04, -0.2, 0, TAU); ctx.fill();
    // 王冠
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath();
    ctx.moveTo(w * 0.24, h * 0.2);
    ctx.lineTo(w * 0.3, h * 0.04); ctx.lineTo(w * 0.4, h * 0.16);
    ctx.lineTo(w * 0.5, h * 0.0); ctx.lineTo(w * 0.6, h * 0.16);
    ctx.lineTo(w * 0.7, h * 0.04); ctx.lineTo(w * 0.76, h * 0.2);
    ctx.closePath(); ctx.fill();
    // 怒目
    const angry = e.ph > 0;
    this.eyes(w * 0.3, h * 0.42, w * 0.4, e.f, 6, flash);
    if (angry) {
      ctx.strokeStyle = '#5c3a1a'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(w * 0.26, h * 0.32); ctx.lineTo(w * 0.42, h * 0.38);
      ctx.moveTo(w * 0.74, h * 0.32); ctx.lineTo(w * 0.58, h * 0.38);
      ctx.stroke();
    }
    ctx.restore();
  }

  eyes(cx, cy, sep, facing, size, flash) {
    const ctx = this.ctx;
    for (const s of [-1, 1]) {
      const x = cx + sep * (s > 0 ? 1 : 0);
      ctx.fillStyle = flash ? '#ffdddd' : '#ffffff';
      ctx.beginPath(); ctx.ellipse(x, cy, size, size * 1.15, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#20160f';
      ctx.beginPath();
      ctx.arc(x + facing * size * 0.28, cy + size * 0.1, size * 0.5, 0, TAU);
      ctx.fill();
    }
  }

  drawPlayers() {
    const ctx = this.ctx;
    for (const p of this.g.view.players) {
      if (!p.alive && !p.downed) continue;
      ctx.save();
      ctx.translate(p.x, p.y);

      // 影子
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath(); ctx.ellipse(p.w / 2, p.h + 3, p.w * 0.5, 5, 0, 0, TAU); ctx.fill();

      if (p.downed) {
        ctx.translate(0, p.h * 0.55);
        ctx.rotate(Math.PI / 2 * 0.9);
        ctx.translate(0, -p.h * 0.2);
      }

      const color = p.color;
      const flash = p.hf > 0;
      const walk = Math.abs(p.vx) > 20 && p.onGround !== false;
      const phase = this.time * 14;

      // 腿
      ctx.fillStyle = '#8a5a2b';
      const lp = walk ? Math.sin(phase) * 5 : 0;
      rr(ctx, p.w * 0.2, p.h - 8 + Math.max(0, lp), 7, 9 - Math.abs(lp) * 0.4, 3); ctx.fill();
      rr(ctx, p.w * 0.55, p.h - 8 + Math.max(0, -lp), 7, 9 - Math.abs(lp) * 0.4, 3); ctx.fill();

      // 身体（土豆）
      const grd = ctx.createLinearGradient(0, 0, 0, p.h);
      grd.addColorStop(0, flash ? '#ffffff' : shade(color, 22));
      grd.addColorStop(1, flash ? '#ffeeee' : shade(color, -26));
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(p.w / 2, p.h * 0.58, p.w * 0.5, p.h * 0.42, 0, 0, TAU);
      ctx.fill();
      // 土豆芽 / 纹理
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.beginPath(); ctx.ellipse(p.w * 0.28, p.h * 0.5, 3, 2, 0.5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(p.w * 0.7, p.h * 0.68, 2.4, 1.8, -0.3, 0, TAU); ctx.fill();

      // 眼睛
      const eyeY = p.h * 0.45;
      const look = p.f >= 0 ? 1 : -1;
      for (const s of [-1, 1]) {
        const ex = p.w / 2 + s * 5.5;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(ex, eyeY, 4.2, 5, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#2a1a10';
        ctx.beginPath(); ctx.arc(ex + look * 1.6, eyeY + 0.8, 2.1, 0, TAU); ctx.fill();
      }
      // 嘴
      ctx.strokeStyle = '#6b3f1d'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(p.w / 2 + look * 1.5, p.h * 0.62, 4, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      // 手持武器
      if (p.weapon) this.handWeapon(p, look);

      // 无敌 / 冲刺特效
      if (p.sp > 0) {
        ctx.strokeStyle = `rgba(120,220,255,${0.35 + Math.sin(this.time * 20) * 0.2})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(p.w / 2, p.h * 0.55, p.w * 0.72, p.h * 0.6, 0, 0, TAU); ctx.stroke();
      }
      ctx.restore();

      // 头顶信息
      const headY = p.y - (p.downed ? 2 : 12);
      this.bar(p.x + p.w / 2, headY, 40, 6, p.hp / p.maxHp, p.isMe ? '#51cf66' : p.color);
      ctx.save();
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      const label = `${p.name}`;
      const tw = ctx.measureText(label).width;
      rr(ctx, p.x + p.w / 2 - tw / 2 - 5, headY - 18, tw + 10, 15, 5); ctx.fill();
      ctx.fillStyle = p.isMe ? '#ffe066' : '#fff';
      ctx.fillText(label, p.x + p.w / 2, headY - 7);
      ctx.restore();

      // 倒地救援进度
      if (p.downed) {
        ctx.save();
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(0, 0, 26, 0, TAU); ctx.stroke();
        ctx.strokeStyle = '#51cf66'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(0, 0, 26, -Math.PI / 2, -Math.PI / 2 + TAU * p.reviveProgress); ctx.stroke();
        ctx.fillStyle = '#ff6b6b'; ctx.font = '700 13px system-ui'; ctx.textAlign = 'center';
        ctx.fillText('倒地! 站上去救人', 0, 46);
        ctx.restore();
      }
    }
  }

  handWeapon(p, look) {
    const ctx = this.ctx;
    const def = weaponById(p.weapon);
    if (!def) return;
    const hx = p.w / 2 + look * (def.type === 'melee' ? 14 : 10);
    const hy = p.h * 0.6;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.scale(look, 1);
    ctx.fillStyle = def.color;
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1;
    switch (def.id) {
      case 'sword':
        rr(ctx, -2, -14, 4, 20, 1); ctx.fill();
        rr(ctx, -6, 4, 12, 3, 1); ctx.fill();
        break;
      case 'stick':
        ctx.save(); ctx.rotate(-0.4); rr(ctx, -2, -12, 4, 22, 2); ctx.fill(); ctx.restore();
        break;
      case 'chainsaw':
        rr(ctx, -4, -8, 12, 8, 2); ctx.fill();
        ctx.fillStyle = '#adb5bd'; rr(ctx, 6, -6, 8, 4, 1); ctx.fill();
        break;
      case 'fist':
        ctx.beginPath(); ctx.arc(2, 0, 6, 0, TAU); ctx.fill();
        break;
      case 'rocket':
        rr(ctx, -3, -12, 14, 8, 2); ctx.fill();
        ctx.fillStyle = '#ff8787'; rr(ctx, 8, -10, 5, 4, 1); ctx.fill();
        break;
      case 'staff':
        ctx.save(); ctx.rotate(-0.3); rr(ctx, -1.5, -14, 3, 24, 1); ctx.fill(); ctx.restore();
        ctx.fillStyle = def.color; ctx.shadowColor = def.color; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(0, -16, 4.5, 0, TAU); ctx.fill();
        break;
      case 'sniper':
        rr(ctx, -4, -4, 20, 4, 1); ctx.fill();
        rr(ctx, 4, 0, 5, 5, 1); ctx.fill();
        break;
      case 'shotgun':
        rr(ctx, -3, -3, 16, 5, 1); ctx.fill();
        rr(ctx, 10, -1, 8, 3, 1); ctx.fill();
        break;
      default:
        rr(ctx, -2, -4, 11, 6, 1.5); ctx.fill();
        rr(ctx, 1, 2, 4, 6, 1); ctx.fill();
    }
    ctx.restore();
  }

  drawBullets() {
    const ctx = this.ctx;
    for (const b of this.g.view.bullets) {
      ctx.save();
      ctx.translate(b.x, b.y);
      if (b.kind === 'swing') {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        const dir = b.vx >= 0 ? 1 : (b.f || 1);
        ctx.beginPath();
        ctx.arc(dir > 0 ? -b.w * 0.2 : b.w * 1.2, b.h / 2, b.w * 0.9, dir > 0 ? -0.9 : Math.PI - 0.9, dir > 0 ? 0.9 : Math.PI + 0.9);
        ctx.stroke();
      } else if (b.kind === 'bullet') {
        const ang = Math.atan2(b.vy, b.vx);
        ctx.rotate(ang);
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = b.r * 2.2;
        if (b.shape === 'rocket') {
          rr(ctx, -b.r * 1.8, -b.r * 0.6, b.r * 3.4, b.r * 1.2, 2); ctx.fill();
          ctx.fillStyle = '#fff3bf';
          ctx.beginPath(); ctx.arc(b.r * 1.6, 0, b.r * 0.7, 0, TAU); ctx.fill();
        } else if (b.shape === 'orb') {
          ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,.65)';
          ctx.beginPath(); ctx.arc(-b.r * 0.25, -b.r * 0.25, b.r * 0.4, 0, TAU); ctx.fill();
        } else if (b.shape === 'boomerang') {
          ctx.rotate(this.time * 18);
          ctx.fillStyle = b.color;
          rr(ctx, -b.r, -b.r * 0.45, b.r * 2, b.r * 0.9, 2); ctx.fill();
          rr(ctx, -b.r * 0.45, -b.r, b.r * 0.9, b.r * 2, 2); ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(b.r * 1.7, 0);
          ctx.lineTo(-b.r, b.r * 0.75);
          ctx.lineTo(-b.r * 0.4, 0);
          ctx.lineTo(-b.r, -b.r * 0.75);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  drawBeams() {
    const ctx = this.ctx;
    for (const b of this.g.beams) {
      const a = Math.max(0, b.life / b.max);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = b.color;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3 + a * 6;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x2, b.y2); ctx.stroke();
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawParticles() {
    const ctx = this.ctx;
    for (const p of this.g.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.save();
      ctx.globalAlpha = a;
      if (p.type === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * a;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - a) + 4, 0, TAU); ctx.stroke();
      } else if (p.type === 'text') {
        ctx.font = `800 ${p.size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = p.color;
        ctx.strokeStyle = 'rgba(0,0,0,.7)';
        ctx.lineWidth = 3;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillText(p.text, p.x, p.y);
      } else if (p.type === 'spark') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * a, 0, TAU);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size * a, p.size * a);
      }
      ctx.restore();
    }
  }

  drawWorldUI() {
    // 屏幕外敌人指示（合作模式提醒）
    const g = this.g;
    const ctx = this.ctx;
    if (g.phase === 'wave') {
      const off = g.view.enemies.filter((e) => e.x < -20 || e.x > g.level.width + 20);
      if (off.length) {
        ctx.save();
        ctx.fillStyle = 'rgba(255,107,107,.9)';
        ctx.font = '600 12px system-ui';
        ctx.fillText(`⚠ 场外还有 ${off.length} 只敌人`, 8, 18);
        ctx.restore();
      }
    }
  }

  bar(cx, y, w, h, ratio, color) {
    const ctx = this.ctx;
    const x = cx - w / 2;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    rr(ctx, x - 1, y - 1, w + 2, h + 2, 3); ctx.fill();
    ctx.fillStyle = color;
    rr(ctx, x, y, Math.max(0, w * Math.max(0, Math.min(1, ratio))), h, 2); ctx.fill();
  }
}

function shade(hex, amt) {
  const c = hex.replace('#', '');
  const num = parseInt(c.length === 3 ? c.split('').map((x) => x + x).join('') : c, 16);
  let r = (num >> 16) + amt, g = ((num >> 8) & 255) + amt, b = (num & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}
