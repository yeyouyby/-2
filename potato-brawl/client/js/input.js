// 键盘输入 → 位掩码。短按会被保持若干 tick，避免在高延迟下丢掉「按下」这一帧。
import { IN } from '/shared/constants.js';

const MAP = {
  KeyA: IN.LEFT, ArrowLeft: IN.LEFT,
  KeyD: IN.RIGHT, ArrowRight: IN.RIGHT,
  Space: IN.JUMP, KeyW: IN.JUMP, ArrowUp: IN.JUMP,
  ShiftLeft: IN.DASH, ShiftRight: IN.DASH,
  KeyS: IN.DOWN, ArrowDown: IN.DOWN,
  KeyE: IN.REVIVE, ControlLeft: IN.REVIVE,
};

export class Input {
  constructor() {
    this.held = new Set();
    this.holdJump = 0;
    this.holdDash = 0;
    this.enabled = false;
    this.mask = 0;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.held.clear(); });
  }

  onKey(e, down) {
    if (e.repeat) return;
    const bit = MAP[e.code];
    if (!bit) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (down) {
      this.held.add(e.code);
      if (bit === IN.JUMP) this.holdJump = 5;
      if (bit === IN.DASH) this.holdDash = 5;
    } else {
      this.held.delete(e.code);
    }
  }

  /** 每个客户端 tick 采样一次 */
  sample() {
    if (!this.enabled) { this.mask = 0; return 0; }
    let m = 0;
    for (const code of this.held) m |= MAP[code] || 0;
    if (this.holdJump > 0) { m |= IN.JUMP; this.holdJump--; }
    if (this.holdDash > 0) { m |= IN.DASH; this.holdDash--; }
    this.mask = m;
    return m;
  }
}
