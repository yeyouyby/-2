// WebSocket 客户端：自动重连、心跳、事件分发
export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.connected = false;
    this.id = null;
    this.name = localStorage.getItem('pb_name') || '';
    this.token = localStorage.getItem('pb_token') || '';
    if (!this.token) {
      this.token = 't_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('pb_token', this.token);
    }
    this.ping = 0;
    this.retry = 0;
    this._pingTimer = null;
    this._lastPingSent = 0;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, msg) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(msg);
  }

  connect(url) {
    this.url = url || this.url || `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws`;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.send({ t: 'hello', name: this.name || '土豆', token: this.token });
      this.emit('status', { connected: true });
      this._pingTimer = setInterval(() => {
        this._lastPingSent = performance.now();
        this.send({ t: 'ping', ts: Date.now() });
      }, 3000);
    };

    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') { this.id = m.id; this.token = m.token; localStorage.setItem('pb_token', m.token); }
      // 登录/注册成功后服务器发的就是「会话 token」：存下来，刷新页面就能免密重连
      if (m.t === 'account' && m.ok && m.token) { this.token = m.token; localStorage.setItem('pb_token', m.token); }
      if (m.t === 'account' && m.action === 'logout') { this.token = ''; localStorage.setItem('pb_token', ''); }
      if (m.t === 'pong') this.ping = Math.round(performance.now() - this._lastPingSent);
      this.emit(m.t, m);
      this.emit('*', m);
    };

    ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.emit('status', { connected: false });
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* 由 onclose 处理 */ };
  }

  scheduleReconnect() {
    this.retry++;
    const delay = Math.min(4000, 400 * this.retry);
    setTimeout(() => { if (!this.connected) this.connect(); }, delay);
  }

  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  setName(n) {
    this.name = n;
    localStorage.setItem('pb_name', n);
  }
}
