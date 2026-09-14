// 共享物理：AABB + 重力 + 平台碰撞。服务器与客户端使用同一份代码，
// 这样客户端才能做「预测 + 服务器回滚校正」而不产生抖动。
import { IN, PHYS } from './constants.js';

export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectsOverlap(a, b) {
  return aabb(a, b);
}

export function circleRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

function approach(v, target, delta) {
  if (v < target) return Math.min(v + delta, target);
  if (v > target) return Math.max(v - delta, target);
  return target;
}

/**
 * 轴分离式移动 + 碰撞解算。body: {x,y,w,h}（x,y 为左上角）
 */
export function moveAndCollide(b, dx, dy, solids) {
  const res = { hitX: false, hitY: false, ground: false, ceil: false };
  b.x += dx;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabb(b, s)) continue;
    if (dx > 0) b.x = s.x - b.w;
    else if (dx < 0) b.x = s.x + s.w;
    b.vx = 0;
    res.hitX = true;
  }
  b.y += dy;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!aabb(b, s)) continue;
    if (dy > 0) { b.y = s.y - b.h; res.ground = true; }
    else if (dy < 0) { b.y = s.y + s.h; res.ceil = true; }
    b.vy = 0;
    res.hitY = true;
  }
  return res;
}

/**
 * 驱动一个角色（玩家）走一个 tick。
 * actor 需要字段：x,y,w,h,vx,vy,facing,onGround,coyote,jumpBuf,jumps,dashCd,dashT,dashDir,iFrames,prevJump,prevDash
 * 返回本 tick 触发的动作标记（用于音效/特效）。
 */
export function stepActor(a, input, dt, solids, o = {}) {
  const speedMul = o.speedMul ?? 1;
  const maxSpeed = (o.speed ?? 250) * speedMul;
  const accel = o.accel ?? PHYS.accel;
  const airAccel = o.airAccel ?? PHYS.airAccel;
  const friction = o.friction ?? PHYS.friction;
  const airFriction = o.airFriction ?? PHYS.airFriction;
  const gravity = (o.gravity ?? PHYS.gravity) * (o.gravityScale ?? 1);
  const maxFall = o.maxFall ?? PHYS.maxFall;
  const maxJumps = o.maxJumps ?? PHYS.maxJumps;

  const dir = ((input & IN.RIGHT) ? 1 : 0) - ((input & IN.LEFT) ? 1 : 0);
  const out = { jumped: false, double: false, dashed: false, landed: false };

  // ---- 计时器 ----
  if (a.iFrames > 0) a.iFrames -= dt;
  if (a.dashCd > 0) a.dashCd -= dt;
  if (a.onGround) { a.coyote = o.coyote ?? PHYS.coyote; a.jumps = 0; }
  else if (a.coyote > 0) a.coyote -= dt;

  // ---- 冲刺 ----
  const dashHeld = (input & IN.DASH) !== 0;
  if (dashHeld && !a.prevDash && a.dashCd <= 0 && a.dashT <= 0 && o.canDash !== false) {
    a.dashT = o.dashTime ?? PHYS.dashTime;
    a.dashDir = dir !== 0 ? dir : (a.facing || 1);
    a.facing = a.dashDir;
    a.dashCd = o.dashCooldown ?? PHYS.dashCooldown;
    a.iFrames = Math.max(a.iFrames || 0, o.dashIFrames ?? PHYS.dashIFrames);
    out.dashed = true;
  }
  a.prevDash = dashHeld;

  if (a.dashT > 0) {
    a.dashT -= dt;
    a.vx = a.dashDir * (o.dashSpeed ?? PHYS.dashSpeed);
    a.vy = 0;
    if (a.dashT <= 0) a.vx *= 0.4;
  } else {
    // ---- 水平 ----
    if (dir !== 0) {
      a.facing = dir;
      const ac = a.onGround ? accel : airAccel;
      a.vx += dir * ac * dt;
      if (Math.sign(a.vx) === dir && Math.abs(a.vx) > maxSpeed) {
        // 击退等外力造成的超速：平滑衰减而不是硬截断
        a.vx = approach(a.vx, dir * maxSpeed, (a.onGround ? friction : airFriction) * dt);
      }
    } else {
      a.vx = approach(a.vx, 0, (a.onGround ? friction : airFriction) * dt);
    }
    // ---- 重力 ----
    a.vy += gravity * dt;
    if (a.vy > maxFall) a.vy = maxFall;
  }

  // ---- 跳跃（带 coyote time + 输入缓冲） ----
  const jumpHeld = (input & IN.JUMP) !== 0;
  if (jumpHeld && !a.prevJump) a.jumpBuf = o.jumpBuffer ?? PHYS.jumpBuffer;
  else if (a.jumpBuf > 0) a.jumpBuf -= dt;
  a.prevJump = jumpHeld;

  if (a.jumpBuf > 0) {
    if (a.onGround || a.coyote > 0) {
      a.vy = -(o.jumpVel ?? PHYS.jumpVel);
      a.onGround = false; a.coyote = 0; a.jumpBuf = 0; a.jumps = 1;
      out.jumped = true;
    } else if (a.jumps < maxJumps) {
      a.vy = -(o.doubleJumpVel ?? PHYS.doubleJumpVel);
      a.jumps += 1; a.jumpBuf = 0;
      out.jumped = true; out.double = true;
    }
  }

  // ---- 积分 ----
  const wasGround = a.onGround;
  a.onGround = false;
  const res = moveAndCollide(a, a.vx * dt, a.vy * dt, solids);
  a.onGround = res.ground;
  if (res.ground && !wasGround) out.landed = true;
  if (res.ground) a.jumps = 0;

  // ---- 世界边界（兜底，防止穿墙） ----
  const W = o.worldW ?? 1600, H = o.worldH ?? 900;
  if (a.x < 0) { a.x = 0; a.vx = 0; }
  if (a.x + a.w > W) { a.x = W - a.w; a.vx = 0; }
  if (a.y > H + 200) { a.y = H - a.h; a.vy = 0; }

  return out;
}

/** 命中矩形：近战挥击范围 */
export function facingRect(actor, reach, height) {
  const w = reach, h = height ?? actor.h + 6;
  const x = actor.facing >= 0 ? actor.x + actor.w - 4 : actor.x - w + 4;
  return { x, y: actor.y + (actor.h - h) / 2, w, h };
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export function centerOf(e) {
  return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
}
