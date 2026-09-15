// 可复现的伪随机数（同一个种子 → 同一场对局，便于复盘/调试）。
// 除了种子还暴露 getState/setState：存档点要连「随机数用到哪儿了」一起记下来，
// 读档之后出场队列、精英怪、暴击这些才会接着原来的序列走，而不是从开局重新摇。
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed = Date.now() >>> 0, state) {
  let a = state === undefined ? (seed >>> 0) : (Number(state) | 0);
  const r = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** 当前内部状态（一个 int32），存进存档点即可 */
  r.getState = () => a | 0;
  r.setState = (v) => { a = Number(v) | 0; };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  return r;
}
