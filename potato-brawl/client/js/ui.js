// 界面层：首页 / 大厅 / 游戏内 HUD / 升级卡 / 商店 / 计分板 / 结算
import { MODE, PHASE } from '/shared/constants.js';
import { ITEM_BY_ID, RARITY_NAME, RARITY_COLOR } from '/shared/items.js';
import { WEAPON_BY_ID, TIER_COLOR } from '/shared/weapons.js';
import { weaponById } from '/shared/weapons.js';

const WICON = {
  pistol: '🔫', fist: '👊', stick: '🪵', smg: '🔫', shotgun: '💥', sword: '⚔️',
  staff: '🔮', sniper: '🎯', boomerang: '🪃', rocket: '🚀', chainsaw: '🪚', laser: '⚡',
};
const IICON = {
  armor: '🛡️', coffee: '☕', muscle: '💪', belt: '🔗', shoes: '👟', apple: '🍎', magnet: '🧲',
  dagger: '🗡️', bandage: '🩹', glasses: '👓', book: '📚', cloak: '🧥', scope: '🔭', powder: '💣',
  spring: '🌀', piggy: '🐷', thorn: '🌵', fang: '🧛', helmet: '⛑️', boots: '🥾', berserk: '😈',
  barrel: '🔫', drink: '🥤', tnt: '🧨', clover: '🍀', wizard: '🧙', feast: '🍖', stone: '🪨',
  exo: '🦾', adrenaline: '💉', giant: '🥋', critcore: '💥', fuel: '🚀', shield: '🛡️',
  crown: '👑', bloodlord: '🩸', windboot: '🌪️', titan: '🗿', nuke: '☢️',
};

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(net, audio) {
    this.net = net;
    this.audio = audio;
    this.game = null;
    this.room = null;
    this.rooms = [];
    this.lastSnap = null;
    this.ready = false;
    this.chatOpen = false;
    this.sbOpen = false;
    this.bannerTimer = 0;
    this.bind();
    this.showScreen('home');
    $('lan-url').textContent = location.origin;
    $('inp-name').value = net.name || '';
  }

  attach(game) { this.game = game; }

  showScreen(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    $(`screen-${id}`).classList.add('active');
    this.screen = id;
    if (id === 'game') requestAnimationFrame(() => this.game && this.game.renderer.resize());
  }

  // ------------------------------------------------------------ 绑定
  bind() {
    $('btn-create').onclick = () => {
      const name = this.pickName();
      this.net.send({ t: 'create', roomName: `${name}的房间`, name });
    };
    $('btn-join').onclick = () => {
      const code = $('inp-code').value.trim().toUpperCase();
      if (code.length !== 4) return this.toast('请输入 4 位房间码');
      this.net.send({ t: 'join', code, name: this.pickName() });
    };
    $('inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
    $('btn-refresh').onclick = () => this.net.send({ t: 'ping', ts: Date.now() });
    $('btn-copy').onclick = () => {
      navigator.clipboard?.writeText(location.origin);
      this.toast('已复制地址，发给局域网里的朋友吧！');
    };
    $('btn-leave').onclick = () => this.leaveRoom();
    $('btn-ready').onclick = () => this.setReady(!this.ready);
    $('btn-start').onclick = () => this.net.send({ t: 'start' });
    $('chat-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('chat-input').value.trim();
      if (v) { this.net.send({ t: 'chat', text: v }); $('chat-input').value = ''; }
    };
    $('btn-quit').onclick = () => { if (confirm('确定退出当前对局？')) this.leaveRoom(); };
    $('btn-mute').onclick = () => {
      const m = this.audio.toggleMute();
      $('btn-mute').textContent = m ? '🔇' : '🔊';
    };
    $('btn-stats').onclick = () => $('stats-panel').classList.toggle('hidden');
    $('btn-reroll').onclick = () => this.net.send({ t: 'reroll' });
    $('btn-shop-ready').onclick = () => {
      this.net.send({ t: 'shopReady', v: true });
      $('btn-shop-ready').disabled = true;
      $('btn-shop-ready').textContent = '已准备 ✓';
    };
    $('btn-back-lobby').onclick = () => { this.net.send({ t: 'back' }); $('result').classList.add('hidden'); };
    $('btn-again').onclick = () => {
      $('result').classList.add('hidden');
      this.net.send({ t: 'back' });
      setTimeout(() => {
        this.net.send({ t: 'ready', v: true });
        if (this.room && this.room.host === this.net.id) setTimeout(() => this.net.send({ t: 'start' }), 400);
      }, 300);
    };

    // 游戏内聊天
    const gform = $('game-chat-form');
    const ginput = $('game-chat-input');
    gform.onsubmit = (e) => {
      e.preventDefault();
      const v = ginput.value.trim();
      if (v) this.net.send({ t: 'chat', text: v });
      ginput.value = '';
      gform.classList.add('hidden');
      ginput.blur();
      this.chatOpen = false;
    };

    window.addEventListener('keydown', (e) => {
      if (this.screen !== 'game') return;
      if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.code === 'Tab') { e.preventDefault(); this.toggleScoreboard(); }
      else if (e.code === 'Enter') {
        e.preventDefault();
        gform.classList.remove('hidden');
        ginput.focus();
        this.chatOpen = true;
      } else if (e.code === 'KeyM') {
        const m = this.audio.toggleMute();
        $('btn-mute').textContent = m ? '🔇' : '🔊';
      } else if (e.code === 'KeyC') {
        $('stats-panel').classList.toggle('hidden');
      } else if (e.code === 'Escape') {
        $('scoreboard').classList.add('hidden');
        $('stats-panel').classList.add('hidden');
      } else if (['Digit1', 'Digit2', 'Digit3'].includes(e.code)) {
        const idx = Number(e.code.slice(5)) - 1;
        if (!$('levelup').classList.contains('hidden')) this.pick(idx);
      }
    });
  }

  leaveRoom() {
    this.net.send({ t: 'leave' });
    this.game && this.game.stop();
    this.ready = false;
    $('result').classList.add('hidden');
    $('shop').classList.add('hidden');
    $('levelup').classList.add('hidden');
    $('tb-banner').classList.remove('show');
    this.showScreen('home');
  }

  pickName() {
    const v = $('inp-name').value.trim() || `土豆${Math.floor(Math.random() * 90 + 10)}`;
    $('inp-name').value = v;
    this.net.setName(v);
    return v;
  }

  setReady(v) {
    this.ready = v;
    this.net.send({ t: 'ready', v });
    $('btn-ready').textContent = v ? '取消准备' : '准备';
    $('btn-ready').classList.toggle('primary', !v);
  }

  toggleScoreboard() {
    const el = $('scoreboard');
    this.sbOpen = el.classList.contains('hidden');
    el.classList.toggle('hidden', !this.sbOpen);
    if (this.sbOpen) this.renderScoreboard();
  }

  toast(msg) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);background:rgba(0,0,0,.85);border:1px solid #ffc857;color:#ffc857;padding:10px 18px;border-radius:10px;z-index:999;font-size:14px;transition:.2s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  banner(text, dur = 1.8) {
    const el = $('tb-banner');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => el.classList.remove('show'), dur * 1000);
  }

  killFeed(killer, victim, color) {
    const box = $('killfeed');
    const d = document.createElement('div');
    d.className = 'kf';
    d.innerHTML = `<b style="color:${color || '#fff'}">${killer}</b> 💀 ${victim}`;
    box.appendChild(d);
    setTimeout(() => d.remove(), 5000);
    while (box.children.length > 5) box.firstChild.remove();
  }

  chatLine(name, text, sys) {
    const logs = [$('chat-log')];
    for (const log of logs) {
      const d = document.createElement('div');
      if (sys) d.className = 'sys';
      d.innerHTML = sys ? text : `<b>${name}</b>：${text}`;
      log.appendChild(d);
      while (log.children.length > 60) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
    }
    // 游戏内浮动聊天
    const g = $('game-chat-log');
    const f = document.createElement('div');
    f.innerHTML = sys ? `<i>${text}</i>` : `<b>${name}</b>：${text}`;
    g.appendChild(f);
    setTimeout(() => f.remove(), 6000);
    while (g.children.length > 6) g.firstChild.remove();
  }

  // ------------------------------------------------------------ 首页
  onRooms(rooms) {
    this.rooms = rooms;
    const box = $('room-list');
    if (!rooms.length) {
      box.innerHTML = '<div class="empty">局域网里还没有房间，点上面的「创建房间」当房主吧！</div>';
      return;
    }
    box.innerHTML = '';
    for (const r of rooms) {
      const d = document.createElement('div');
      d.className = 'room-item';
      const modeName = { pve: '合作 PvE', ffa: '死斗', team: '团队战' }[r.mode] || r.mode;
      d.innerHTML = `<span class="code">${r.code}</span>
        <span>${r.name}</span>
        <span class="tag">${modeName}</span>
        <span class="meta">${r.phase === 'game' ? '进行中 第' + r.wave + '波' : '等待中'} · ${r.players}/${r.max} 人</span>`;
      d.onclick = () => this.net.send({ t: 'join', code: r.code, name: this.pickName() });
      box.appendChild(d);
    }
  }

  onStatus(st) {
    const el = $('home-conn');
    el.textContent = st.connected ? '● 已连接到服务器' : '● 连接断开，正在重连…';
    el.className = 'conn ' + (st.connected ? 'on' : 'off');
  }

  // ------------------------------------------------------------ 大厅
  onRoom(state) {
    this.room = state;
    if (state.players.some((p) => p.id === this.net.id) && this.screen !== 'game') this.showScreen('lobby');
    this.game && this.game.setRoster(state);
    $('lobby-title').textContent = state.name;
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = `${state.players.length}/${state.maxPlayers}`;
    const me = state.players.find((p) => p.id === this.net.id);
    this.ready = me ? me.ready : false;
    $('btn-ready').textContent = this.ready ? '取消准备' : '准备';
    $('btn-start').classList.toggle('hidden', !(me && me.host));

    // 玩家列表
    const box = $('player-list');
    box.innerHTML = '';
    for (const p of state.players) {
      const d = document.createElement('div');
      d.className = 'pl' + (p.host ? ' host' : '');
      const badges = [];
      if (p.host) badges.push('<span class="badge">房主</span>');
      if (p.ready) badges.push('<span class="badge ready">已准备</span>');
      if (state.settings.mode === MODE.TEAM) badges.push(`<span class="badge team${p.team}">${p.team === 0 ? '蓝队' : '红队'}</span>`);
      const isMe = p.id === this.net.id;
      const weaponSel = isMe ? `
        <select class="wsel" data-for="${p.id}">
          ${['pistol', 'fist', 'stick'].map((w) => `<option value="${w}" ${p.startWeapon === w ? 'selected' : ''}>${WICON[w]} ${weaponById(w).name}</option>`).join('')}
        </select>` : `<span class="muted small">${WICON[p.startWeapon] || '🔫'} ${(weaponById(p.startWeapon) || {}).name || ''}</span>`;
      const teamBtns = (isMe && state.settings.mode === MODE.TEAM) ? `
        <button class="small" data-team="0">蓝</button><button class="small" data-team="1">红</button>` : '';
      d.innerHTML = `
        <span class="dot" style="background:${['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#22b8cf', '#ff922b', '#f783ac'][p.slot % 8]}"></span>
        <span class="nm">${p.name}${isMe ? ' <span class="muted small">(你)</span>' : ''}</span>
        <span class="badges">${badges.join('')}</span>
        <span class="right">${weaponSel}${teamBtns}</span>`;
      box.appendChild(d);
    }
    box.querySelectorAll('.wsel').forEach((sel) => {
      sel.onchange = () => this.net.send({ t: 'loadout', weapon: sel.value });
    });
    box.querySelectorAll('[data-team]').forEach((btn) => {
      btn.onclick = () => this.net.send({ t: 'setTeam', team: Number(btn.dataset.team) });
    });

    // 设置（房主可改）
    const isHost = me && me.host;
    const s = state.settings;
    $('settings-box').innerHTML = `
      ${this.segRow('模式', 'mode', [['pve', '合作 PvE'], ['ffa', '死斗 PvP'], ['team', '团队 PvP']], s.mode, isHost)}
      ${this.segRow('地图', 'levelId', [['farm', '土豆农场'], ['cellar', '地窖酒馆']], s.levelId, isHost)}
      ${this.segRow('人数上限', 'maxPlayers', [2, 3, 4, 6, 8].map((n) => [n, n + ' 人']), s.maxPlayers, isHost)}
      ${s.mode === 'pve'
        ? `${this.segRow('总波数', 'totalWaves', [[10, '10 波'], [20, '20 波'], [30, '30 波']], s.totalWaves, isHost)}
           ${this.segRow('难度', 'difficulty', [[0.7, '休闲'], [1, '标准'], [1.35, '困难'], [1.8, '地狱']], s.difficulty, isHost)}
           ${this.segRow('备战时长', 'prepTime', [[12, '12 秒'], [20, '20 秒'], [35, '35 秒']], s.prepTime, isHost)}`
        : `${this.segRow('分数上限', 'scoreLimit', [[10, '10 分'], [20, '20 分'], [30, '30 分']], s.scoreLimit, isHost)}
           ${this.segRow('时间上限', 'timeLimit', [[180, '3 分钟'], [300, '5 分钟'], [600, '10 分钟']], s.timeLimit, isHost)}`}
    `;
    $('settings-box').querySelectorAll('[data-key]').forEach((btn) => {
      if (!isHost) return;
      btn.onclick = () => {
        const key = btn.dataset.key;
        let val = btn.dataset.val;
        val = ['maxPlayers', 'totalWaves', 'scoreLimit', 'timeLimit'].includes(key) ? Number(val) : (isNaN(Number(val)) ? val : Number(val));
        this.net.send({ t: 'settings', settings: { [key]: val } });
      };
    });

    // 提示
    const tips = [];
    if (!isHost) tips.push('等房主开始游戏');
    else if (state.players.length < 2 && s.mode !== 'pve') tips.push('PvP 至少需要 2 名玩家');
    else tips.push('所有人准备后即可开始');
    $('lobby-tip').textContent = tips.join(' · ');
  }

  segRow(label, key, opts, cur, enabled) {
    return `<div class="set-row"><label>${label}</label><div class="seg">
      ${opts.map(([v, t]) => `<button data-key="${key}" data-val="${v}" class="${String(v) === String(cur) ? 'on' : ''}" ${enabled ? '' : 'disabled'}>${t}</button>`).join('')}
    </div></div>`;
  }

  // ------------------------------------------------------------ 游戏内
  onGameStart(msg) {
    this.showScreen('game');
    $('result').classList.add('hidden');
    $('scoreboard').classList.add('hidden');
    $('killfeed').innerHTML = '';
    $('game-chat-log').innerHTML = '';
    $('tb-mode').textContent = { pve: '合作 PvE', ffa: '死斗 PvP', team: '团队 PvP' }[msg.mode] || msg.mode;
    $('tb-timer').classList.toggle('hidden', msg.mode === 'pve');
    $('tb-wave').classList.toggle('hidden', msg.mode !== 'pve');
    this.banner('准备…', 2.5);
    this.audio.ensure();
  }

  onSnapshot(s) {
    this.lastSnap = s;
    const me = s.me;
    const ph = s.ph;

    // 顶部
    if (this.game && this.game.mode === 'pve') {
      $('tb-wave').textContent = s.ph === 'wave' && s.e.length
        ? `波次 ${s.w} / ${s.tw} · 剩余 ${s.e.length}`
        : `波次 ${s.w} / ${s.tw}`;
      const boss = s.e.find((e) => e.t === 'boss');
      const bb = $('bossbar');
      if (boss) {
        bb.classList.remove('hidden');
        $('bb-fill').style.width = Math.max(0, Math.min(100, (boss.hp / boss.mx) * 100)) + '%';
      } else bb.classList.add('hidden');
    }
    if (s.tl !== undefined) {
      const t = Math.max(0, s.tl);
      $('tb-timer').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    }
    $('tb-ping').textContent = `${this.net.ping}ms`;

    if (!me) return;

    // 血条 / 经验 / 金币
    const hpPct = Math.max(0, me.hp / me.mx) * 100;
    $('hp-fill').style.width = hpPct + '%';
    $('hp-text').textContent = `${Math.ceil(me.hp)} / ${me.mx}`;
    $('xp-fill').style.width = Math.min(100, (me.xp / me.xn) * 100) + '%';
    $('xp-text').textContent = `Lv.${me.lv}`;
    $('hud-coins').textContent = `🪙 ${me.coins}`;
    $('hud-kills').textContent = `💀 ${me.kills}`;

    // 武器栏
    const wbox = $('hud-weapons');
    if (wbox.children.length !== me.w.length) {
      wbox.innerHTML = me.w.map((w) => {
        const def = weaponById(w.id);
        return `<div class="wslot" title="${def.name}"><span class="icon">${WICON[w.id] || '🔫'}</span><div class="cd"></div><span class="nm">${def.name}</span></div>`;
      }).join('');
    }
    me.w.forEach((w, i) => {
      const el = wbox.children[i];
      if (!el) return;
      const def = weaponById(w.id);
      const pct = Math.min(100, (w.cd / def.cd) * 100);
      el.querySelector('.cd').style.height = pct + '%';
      el.querySelector('.nm').textContent = def.name;
    });

    // 属性面板
    const st = me.st;
    $('stats-panel').innerHTML = `
      ${this.sr('伤害倍率', (st.dmg * 100).toFixed(0) + '%')}
      ${this.sr('攻击速度', (st.as * 100).toFixed(0) + '%')}
      ${this.sr('暴击率 / 暴伤', (st.crit * 100).toFixed(0) + '% / ' + st.critMul.toFixed(2) + 'x')}
      ${this.sr('移动速度', (st.spd * 100).toFixed(0) + '%')}
      ${this.sr('生命上限', me.mx)}
      ${this.sr('减伤', st.armor + ' / ' + (st.ap * 100).toFixed(0) + '%')}
      ${this.sr('闪避', (st.dodge * 100).toFixed(0) + '%')}
      ${this.sr('吸血', (st.ls * 100).toFixed(0) + '%')}
      ${this.sr('回复/秒', st.regen.toFixed(1))}
      ${this.sr('近战/远程/魔法', `${st.melee} / ${st.ranged} / ${st.magic}`)}
      ${this.sr('额外弹丸', '+' + st.proj)}
      ${this.sr('拾取范围', '+' + st.pick)}
      ${this.sr('反伤', st.thorns)}
    `;

    // 升级三选一
    const lu = $('levelup');
    if (me.ch && me.ch.length) {
      if (lu.dataset.sig !== JSON.stringify(me.ch)) {
        lu.dataset.sig = JSON.stringify(me.ch);
        this.renderCards(me.ch);
      }
      lu.classList.remove('hidden');
      $('lu-queue').textContent = me.pl > 1 ? `(还有 ${me.pl - 1} 次待选)` : '';
    } else {
      lu.classList.add('hidden');
      lu.dataset.sig = '';
    }

    // 商店
    const shop = $('shop');
    if (me.sh && ph === 'prep') {
      shop.classList.remove('hidden');
      $('shop-timer').textContent = `${Math.ceil(s.pt)} 秒后开始下一波`;
      $('shop-coins').textContent = me.coins;
      const rb = $('btn-reroll');
      rb.textContent = `刷新 (${me.rr})`;
      rb.disabled = me.coins < me.rr;
      const ob = $('shop-offers');
      const sig = JSON.stringify(me.sh.offers) + me.coins;
      if (ob.dataset.sig !== sig) {
        ob.dataset.sig = sig;
        ob.innerHTML = me.sh.offers.map((o, i) => {
          const def = o.kind === 'item' ? ITEM_BY_ID[o.id] : WEAPON_BY_ID[o.id];
          const icon = o.kind === 'item' ? (IICON[o.id] || '✨') : (WICON[o.id] || '🔫');
          const col = o.kind === 'item' ? RARITY_COLOR[def.rarity] : TIER_COLOR[def.tier];
          return `<div class="offer ${o.sold ? 'sold' : ''} ${me.coins < o.price ? 'poor' : ''}" data-idx="${i}">
            <div class="icon">${icon}</div>
            <div class="nm" style="color:${col}">${def.name}</div>
            <div class="ds">${def.desc}</div>
            <div class="pr">🪙 ${o.price}</div>
          </div>`;
        }).join('');
        ob.querySelectorAll('.offer').forEach((el) => {
          el.onclick = () => this.net.send({ t: 'buy', idx: Number(el.dataset.idx) });
        });
      }
      $('btn-shop-ready').disabled = !!me.sh.ready;
      $('btn-shop-ready').textContent = me.sh.ready ? '已准备 ✓' : '准备完毕';
    } else {
      shop.classList.add('hidden');
      $('shop-offers').dataset.sig = '';
    }

    // 中央提示
    const cm = $('center-msg');
    let msg = '';
    if (!this.myAlive(s)) {
      if (s.me.dtm > 0) msg = `<div>💀 你倒下了</div><div class="sub">坚持 ${Math.ceil(s.me.dtm)} 秒让队友来救你</div>`;
      else msg = `<div>💀 阵亡</div><div class="sub">${Math.ceil(s.me.rt)} 秒后重新参战</div>`;
    } else if (ph === 'countdown') {
      msg = `<div>准备…</div><div class="sub">${Math.ceil(s.pt)} 秒后开始</div>`;
    } else if (ph === 'prep') {
      msg = `<div>🛒 备战阶段</div><div class="sub">${Math.ceil(s.pt)} 秒后开始第 ${s.w + 1} 波</div>`;
    }
    if (msg) { cm.innerHTML = msg; cm.classList.remove('hidden'); }
    else cm.classList.add('hidden');

    if (this.sbOpen) this.renderScoreboard();
  }

  sr(k, v) { return `<div class="sr"><span>${k}</span><span>${v}</span></div>`; }

  myAlive(s) {
    const mine = s.p.find((p) => p.i === this.net.id);
    return !mine || mine.a === 1;
  }

  renderCards(choices) {
    const box = $('lu-cards');
    box.innerHTML = choices.map((c, i) => {
      const def = c.kind === 'item' ? ITEM_BY_ID[c.id] : WEAPON_BY_ID[c.id];
      const icon = c.kind === 'item' ? (IICON[c.id] || '✨') : (WICON[c.id] || '🔫');
      const col = c.kind === 'item' ? RARITY_COLOR[def.rarity] : TIER_COLOR[def.tier];
      const rname = c.kind === 'item' ? RARITY_NAME[def.rarity] : `${def.tier} 级武器`;
      const extra = c.kind === 'weapon'
        ? `伤害 ${def.dmg} · 冷却 ${def.cd}s`
        : (this.game && this.game.roster ? '' : '');
      const owned = c.kind === 'item' && this.lastSnap && this.lastSnap.me.it[c.id]
        ? `<div class="desc" style="color:#ffc857">已持有 ${this.lastSnap.me.it[c.id]} 个</div>` : '';
      return `<div class="lu-card" data-idx="${i}">
        <div class="rar" style="background:${col};color:#1a1208">${rname}</div>
        <div class="key">${i + 1}</div>
        <div class="icon">${icon}</div>
        <div class="name" style="color:${col}">${def.name}</div>
        <div class="desc">${def.desc}</div>
        ${extra ? `<div class="desc" style="color:#9fb3c8">${extra}</div>` : ''}
        ${owned}
      </div>`;
    }).join('');
    box.querySelectorAll('.lu-card').forEach((el) => {
      el.onclick = () => this.pick(Number(el.dataset.idx));
    });
  }

  pick(idx) {
    this.net.send({ t: 'pick', idx });
    $('levelup').classList.add('hidden');
  }

  renderScoreboard() {
    const s = this.lastSnap;
    if (!s) return;
    const rows = s.p.map((p) => {
      const name = this.game ? this.game.nameOf(p.i, '玩家') : '玩家';
      const st = p.a ? (p.d ? '倒地' : '存活') : '阵亡';
      const team = s.p.length && p.tm >= 0 && this.game && this.game.mode === 'team'
        ? `<span style="color:${p.tm === 0 ? '#4dabf7' : '#ff8787'}">●</span> ` : '';
      return `<tr><td>${team}${name}</td><td>${p.l}</td><td>${p.k}</td><td>${p.dd}</td><td>${p.mx}</td><td>${st}</td></tr>`;
    }).join('');
    $('sb-body').innerHTML = rows;
  }

  onOver(result) {
    const win = result.win;
    $('result-title').textContent = win ? '🎉 胜利！' : '💀 失败…';
    $('result-title').style.color = win ? '#ffd43b' : '#ff8787';
    const reasons = { clear: '你们守住了全部波次！', wipe: '全员倒地，土豆军团失败了…', time: '时间到', team0: '蓝队获胜', team1: '红队获胜' };
    $('result-sub').textContent = `${reasons[result.reason] || result.reason} · 第 ${result.wave} 波 · 用时 ${result.duration}s`;
    $('result-body').innerHTML = result.players.map((p) => {
      const build = [
        ...p.weapons.map((w) => WICON[w] || '🔫'),
        ...Object.entries(p.items).map(([k, v]) => (IICON[k] || '✨') + (v > 1 ? v : '')),
      ].join(' ');
      return `<tr><td>${p.name}</td><td>${p.level}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.damage}</td><td class="build">${build}</td></tr>`;
    }).join('');
    $('result').classList.remove('hidden');
    if (win) this.audio.win(); else this.audio.lose();
    this.ready = false;
  }

  onLobby() {
    this.showScreen('lobby');
    this.ready = false;
    $('btn-ready').textContent = '准备';
    $('btn-ready').classList.add('primary');
  }
}

export { PHASE };
