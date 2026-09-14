// 极简 WebAudio 音效合成（不依赖任何音频文件）
export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('pb_mute') === '1';
    this.gain = null;
    this.last = new Map();
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.28;
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('pb_mute', this.muted ? '1' : '0');
    if (this.gain) this.gain.gain.value = this.muted ? 0 : 0.28;
    return this.muted;
  }

  /** 同一音效在很短时间内只播一次，避免爆音 */
  throttle(key, ms) {
    const now = performance.now();
    if ((this.last.get(key) || 0) + ms > now) return false;
    this.last.set(key, now);
    return true;
  }

  tone({ freq = 440, to = null, dur = 0.12, type = 'square', vol = 0.5, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.gain);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.16, vol = 0.4, lp = 1200, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = lp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(this.gain);
    src.start(t0);
  }

  shoot(weapon) {
    if (!this.throttle('shoot' + weapon, 45)) return;
    if (weapon === 'shotgun') this.noise({ dur: 0.16, vol: 0.5, lp: 2200 });
    else if (weapon === 'sniper') this.tone({ freq: 900, to: 120, dur: 0.18, type: 'sawtooth', vol: 0.35 });
    else if (weapon === 'laser') this.tone({ freq: 1400, to: 500, dur: 0.1, type: 'sawtooth', vol: 0.25 });
    else if (weapon === 'rocket') this.noise({ dur: 0.25, vol: 0.4, lp: 900 });
    else this.tone({ freq: 620, to: 320, dur: 0.07, type: 'square', vol: 0.22 });
  }
  swing() { if (this.throttle('swing', 60)) this.noise({ dur: 0.1, vol: 0.22, lp: 3600 }); }
  hit(crit) {
    if (!this.throttle('hit', 30)) return;
    this.noise({ dur: 0.07, vol: crit ? 0.34 : 0.2, lp: crit ? 4000 : 2400 });
    if (crit) this.tone({ freq: 1200, to: 700, dur: 0.06, type: 'triangle', vol: 0.2 });
  }
  hurt() {
    if (!this.throttle('hurt', 120)) return;
    this.tone({ freq: 220, to: 90, dur: 0.18, type: 'sawtooth', vol: 0.35 });
  }
  kill() {
    if (!this.throttle('kill', 60)) return;
    this.tone({ freq: 320, to: 90, dur: 0.22, type: 'triangle', vol: 0.35 });
    this.noise({ dur: 0.2, vol: 0.25, lp: 1600 });
  }
  boom() { this.noise({ dur: 0.45, vol: 0.55, lp: 700 }); this.tone({ freq: 120, to: 40, dur: 0.4, type: 'sine', vol: 0.4 }); }
  jump() { if (this.throttle('jump', 80)) this.tone({ freq: 420, to: 720, dur: 0.09, type: 'sine', vol: 0.18 }); }
  dash() { if (this.throttle('dash', 150)) this.noise({ dur: 0.14, vol: 0.2, lp: 5000 }); }
  levelup() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.14, type: 'triangle', vol: 0.3, delay: i * 0.07 }));
  }
  coin() { if (this.throttle('coin', 60)) this.tone({ freq: 1046, to: 1568, dur: 0.08, type: 'square', vol: 0.14 }); }
  wave() { [392, 523, 659].forEach((f, i) => this.tone({ freq: f, dur: 0.25, type: 'sawtooth', vol: 0.22, delay: i * 0.1 })); }
  down() { this.tone({ freq: 300, to: 60, dur: 0.6, type: 'sawtooth', vol: 0.35 }); }
  revive() { [523, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'sine', vol: 0.3, delay: i * 0.08 })); }
  win() { [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'triangle', vol: 0.3, delay: i * 0.12 })); }
  lose() { [392, 330, 262, 196].forEach((f, i) => this.tone({ freq: f, dur: 0.4, type: 'sawtooth', vol: 0.28, delay: i * 0.18 })); }
}
