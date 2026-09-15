// 入口：把网络、输入、音频、渲染、界面串起来
import { Net } from './net.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { GameClient } from './game.js';
import { UI } from './ui.js';

const net = new Net();
const audio = new Audio();
const ui = new UI(net, audio);
const game = new GameClient(net, audio, ui);
ui.attach(game);
game.input = new Input();

// 暴露给控制台，方便调试
window.PB = { net, ui, game, audio };

net.on('status', (st) => ui.onStatus(st));
net.on('rooms', (m) => ui.onRooms(m.rooms));
net.on('room', (m) => ui.onRoom(m.room));
net.on('start', (m) => { ui.onGameStart(m); game.start(m); });
net.on('snap', (m) => { game.onSnapshot(m); ui.onSnapshot(m); });
net.on('chat', (m) => ui.chatLine(m.name, m.text, m.sys));
net.on('over', (m) => ui.onOver(m.result));
net.on('lobby', () => { game.stop(); ui.onLobby(); });
net.on('err', (m) => ui.toast(m.msg));
net.on('welcome', (m) => ui.onWelcome(m));
net.on('account', (m) => ui.onAccount(m));
net.on('needLogin', (m) => ui.needLoginTip(m));
net.on('saveList', (m) => ui.renderSaves(m.saves));
net.on('saved', (m) => ui.onSaved(m));
net.on('loaded', (m) => ui.onLoaded(m));

net.connect();

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (ui.screen === 'game') game.frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 首次交互后解锁音频（浏览器策略）
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });
window.addEventListener('keydown', () => audio.ensure(), { once: true });
