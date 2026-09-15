#!/usr/bin/env node
// 命令行备份工具：导出一份明文 JSON / 从一份明文 JSON 还原。
//
//   node tools/data-cli.js export                    # → backups/potato-brawl-backup-<时间>.json
//   node tools/data-cli.js export --out /tmp/x.json
//   node tools/data-cli.js list                       # 账号与存档摘要
//   node tools/data-cli.js import backups/x.json     # 覆盖式还原（先自动留一份回滚）
//   node tools/data-cli.js import backups/x.json --merge
//   node tools/data-cli.js verify backups/x.json     # 只检查格式，不动数据
//
// 数据目录用 --data-dir 指定（默认 <项目根>/data）。服务器在跑时默认拒绝 import，
// 要还原正在跑的服务器请用管理页 http://localhost:3000/admin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../server/src/data/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

const cmd = process.argv[2] || 'help';
const dataDir = arg('data-dir', path.join(ROOT, 'data'));
const store = new JsonStore(dataDir);

function needStore() {
  if (!fs.existsSync(store.dir)) {
    console.error(`\n  ❌ 数据目录不存在：${store.dir}\n     服务器还没跑过，或者 --data-dir 给错了。\n`);
    process.exit(1);
  }
  store.loadSync();
}

function busyCheck(what) {
  const busy = JsonStore.dirBusy(dataDir);
  if (busy && !has('force')) {
    console.error(`\n  ❌ 服务器正在跑（${typeof busy === 'number' ? 'pid ' + busy : busy}），${what}会跟它抢文件。`);
    console.error('     要么先用管理页 /admin，要么停掉服务器，要么加 --force（自己承担风险）。\n');
    process.exit(1);
  }
  return pid;
}

function outPath() {
  const given = arg('out', '');
  if (given) return path.resolve(given);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(ROOT, 'backups', `potato-brawl-backup-${stamp}.json`);
}

switch (cmd) {
  case 'export': {
    needStore();
    const bundle = store.exportBundle();
    const file = outPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
    const size = fs.statSync(file).size;
    console.log(`\n  ✅ 已导出 ${bundle.counts.accounts} 个账号 / ${bundle.counts.saves} 个存档`);
    console.log(`     ${file}  (${(size / 1024).toFixed(1)} KB)\n`);
    break;
  }
  case 'verify': {
    const file = process.argv[3];
    if (!file) { console.error('\n  用法：node tools/data-cli.js verify <备份文件>\n'); process.exit(1); }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
    catch (e) { console.error('\n  ❌ 读不了：' + e.message + '\n'); process.exit(1); }
    try {
      // 用同一套校验逻辑，但不落到盘上
      const probe = new JsonStore(path.join(process.env.TMPDIR || '/tmp', 'pb-verify-' + Date.now()));
      probe.loadSync();
      const r = probe.importBundle(doc, { merge: false });
      console.log(`\n  ✅ 备份可用：账号 ${r.accounts} · 存档 ${r.saves}${r.skipped ? ` · 跳过 ${r.skipped} 条坏数据` : ''}\n`);
    } catch (e) {
      console.error(`\n  ❌ 备份不合格：${e.message}\n`);
      process.exit(1);
    }
    break;
  }
  case 'import': {
    const file = process.argv[3];
    if (!file) { console.error('\n  用法：node tools/data-cli.js import <备份文件> [--merge] [--data-dir 路径]\n'); process.exit(1); }
    needStore();
    busyCheck('导入');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
    catch (e) { console.error('\n  ❌ 读不了备份：' + e.message + '\n'); process.exit(1); }
    const merge = has('merge');
    let rollback = '';
    if (!merge && fs.existsSync(store.accountsFile)) {
      rollback = path.join(dataDir, `backup-before-import-${Date.now()}.json`);
      fs.writeFileSync(rollback, JSON.stringify(store.exportBundle(), null, 2) + '\n');
    }
    const r = store.importBundle(doc, { merge });
    const aJson = JSON.stringify(store.accountsDoc, null, 2) + '\n';
    const sJson = JSON.stringify(store.savesDoc, null, 2) + '\n';
    JSON.parse(aJson); JSON.parse(sJson);          // 落盘前自证一遍能读回来
    fs.writeFileSync(store.accountsFile, aJson);
    fs.writeFileSync(store.savesFile, sJson);
    console.log(`\n  ✅ ${merge ? '合并' : '覆盖'}导入完成：账号 ${r.accounts} · 存档 ${r.saves}${r.skipped ? ` · 跳过坏数据 ${r.skipped} 条` : ''}`);
    if (rollback) console.log(`     回滚文件：${rollback}`);
    console.log(`     数据目录：${dataDir}\n`);
    break;
  }
  case 'list': {
    needStore();
    const accs = Object.values(store.accountsDoc.accounts);
    console.log(`\n  数据目录 ${store.dir}`);
    console.log(`  账号 ${accs.length} 个：`);
    for (const a of accs.slice(0, 30)) {
      console.log(`    · ${a.user.padEnd(14)} 显示名 ${String(a.name).padEnd(10)} 场次 ${a.stats.matches} 最佳第 ${a.stats.bestWave} 波 · 无尽最高 ${a.stats.endless.bestWave} 波`);
    }
    if (accs.length > 30) console.log(`    …共 ${accs.length} 个`);
    const saves = store.listSaves();
    console.log(`  存档 ${saves.length} 个：`);
    for (const r of saves.slice(0, 30)) {
      const who = (r.players || []).map((p) => `${p.name} Lv${p.level}`).join('、');
      console.log(`    · ${r.id}  ${new Date(r.createdAt || 0).toLocaleString()}  [${r.mode === 'endless' ? '无尽' : r.mode}] ${r.label || `第${(r.wave | 0) + 1}波前`}  ${who || '空'}`);
    }
    if (saves.length > 30) console.log(`    …共 ${saves.length} 个`);
    console.log('');
    break;
  }
  default:
    console.log(`
  Potato Brawl 数据工具（明文 JSON 备份）

    node tools/data-cli.js export                 导出全部账号+存档到 backups/*.json
    node tools/data-cli.js list                   看一眼有什么
    node tools/data-cli.js verify <file>          检查备份格式（不写盘）
    node tools/data-cli.js import <file> [--merge]  还原（覆盖式会先留回滚文件）

    可选：--data-dir <目录>（默认 ${path.join(ROOT, 'data')}）、--force（服务器在跑也硬来）
`);
}
