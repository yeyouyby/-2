// 管理入口：备份导出 / 导入还原（+ 一个极简管理页）。
//
// 数据全是明文 JSON（见 server/src/data/store.js），所以备份就是那两份文档的合并；
// 导入前先自动写一份 backup-before-import-*.json，还原砸了还能手动换回去。
// 口令：--admin-key / PB_ADMIN_KEY，没给就自动生成到 data/admin-key.txt（不进备份包）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 32 * 1024 * 1024;      // 备份体积上限，超了直接拒

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 自动生成/读取管理口令；顺带把权限收窄到只有本用户可读 */
export function ensureAdminKey(dataDir, explicit) {
  if (explicit) return String(explicit);
  const file = path.join(dataDir, 'admin-key.txt');
  try {
    const cur = fs.readFileSync(file, 'utf8').trim();
    if (cur) return cur;
  } catch { /* 还没有 */ }
  const key = crypto.randomBytes(9).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  } catch { /* 只读盘也不影响，用内存里的 */ }
  return key;
}

function authed(req, url, key) {
  const got = String(req.headers['x-pb-admin'] || url.searchParams.get('key') || '');
  const a = Buffer.from(got), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Potato Brawl · 数据管理</title>
<style>
:root{color-scheme:dark}body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#151b2b;color:#e8eaf0;padding:32px 20px}
.wrap{max-width:720px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}small{color:#8f9bb3}
.card{background:#1d2740;border:1px solid #2c3a5c;border-radius:12px;padding:16px 18px;margin:16px 0}
button,input[type=password],input[type=file]{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #3a4a70;background:#131a2b;color:#e8eaf0}
button{cursor:pointer;background:#2f6df6;border-color:#2f6df6}button.ghost{background:transparent;border-color:#3a4a70}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace}pre{background:#111828;padding:10px;border-radius:8px;overflow:auto;max-height:220px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.kv{display:flex;gap:18px;flex-wrap:wrap;color:#b9c2d4}
label{display:flex;gap:6px;align-items:center;color:#b9c2d4}
.ok{color:#7bd88f}.bad{color:#ff8787}.hint{color:#8f9bb3;font-size:13px}
</style></head><body><div class="wrap">
<h1>🥔 Potato Brawl · 数据管理 <small>备份导出 / 导入还原</small></h1>
<div class="card"><div class="row"><input id="key" type="password" placeholder="管理口令（data/admin-key.txt）" size="28">
<button onclick="save()">保存口令</button><span id="who" class="hint"></span></div>
<div class="kv" id="stats">未加载</div></div>
<div class="card"><b>导出备份</b><div class="hint">一份明文 JSON：全部账号 + 全部检查点存档。口令不会包含在内。</div>
<div class="row" style="margin-top:8px"><button onclick="exp()">⬇ 下载备份</button>
<button class="ghost" onclick="copyJson()">复制到剪贴板</button><span id="expMsg" class="hint"></span></div></div>
<div class="card"><b>导入还原</b><div class="hint">覆盖式还原会先自动把当前数据存成 <code>data/backup-before-import-*.json</code>。</div>
<div class="row" style="margin-top:8px"><input id="file" type="file" accept=".json,application/json">
<label><input id="merge" type="checkbox"> 合并（只覆盖同名账号/同 id 存档）</label>
<button onclick="imp()">⬆ 导入</button><span id="impMsg" class="hint"></span></div><pre id="out" hidden></pre></div>
<div class="hint">提醒：数据目录里的文件是明文（含密码），别把它共享出去或放进公开仓库。</div>
</div>
<script>
const K='pb_admin_key';const g=(id)=>document.getElementById(id);
g('key').value=sessionStorage.getItem(K)||'';
function key(){const v=g('key').value.trim();sessionStorage.setItem(K,v);return v}
function save(){key();load();g('who').textContent='口令已记住（本标签页内）'}
function h(){return {'x-pb-admin':key()}}
async function load(){try{const r=await fetch('/admin/stats',{headers:h()});const j=await r.json();
if(!r.ok)throw 0;g('stats').innerHTML=Object.entries(j).filter(([k])=>k!=='t').map(([k,v])=>'<span>'+k+' <b>'+v+'</b></span>').join('');}
catch{g('stats').textContent='读不到摘要：口令对不对？';}}
async function exp(){try{const r=await fetch('/admin/export',{headers:h()});if(!r.ok)throw 0;
const t=await r.text();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'application/json'}));
a.download='potato-brawl-backup-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,16)+'.json';a.click();
g('expMsg').textContent='已下载 '+t.length+' 字节';}catch{g('expMsg').textContent='导出失败：口令不对或服务器没开存储';}}
async function copyJson(){try{const r=await fetch('/admin/export',{headers:h()});await navigator.clipboard.writeText(await r.text());
g('expMsg').textContent='已复制';}catch{g('expMsg').textContent='复制失败';}}
async function imp(){const f=g('file').files[0];if(!f){g('impMsg').textContent='先选一个备份文件';return;}
g('impMsg').textContent='导入中…';
try{const body=await f.text();const q=g('merge').checked?'?merge=1':'';
const r=await fetch('/admin/import'+q,{method:'POST',headers:Object.assign({'content-type':'application/json'},h()),body});
const j=await r.json();g('out').hidden=false;g('out').textContent=JSON.stringify(j,null,2);
g('impMsg').innerHTML=(r.ok?'<span class=ok>完成</span>':'<span class=bad>失败</span>')+' 账号 '+ (j.imported?.accounts??'-')+' · 存档 '+(j.imported?.saves??'-');
load();}catch(e){g('impMsg').textContent='导入出错：'+e.message;}}
load();
</script></body></html>`;

/**
 * @returns {Promise<boolean>} true = 这个请求已由管理模块处理掉了
 */
export function makeAdminHandler({ store, key, manager, afterImport = null }) {
  return async function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p !== '/admin' && !p.startsWith('/admin/')) return false;
    if (!store) { json(res, 503, { error: '服务器没开存储（--data-dir 被关掉了？）' }); return true; }
    if (p === '/admin' || p === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return true;
    }
    if (!key || !authed(req, url, key)) { json(res, 401, { error: '管理口令不对' }); return true; }

    if (p === '/admin/stats') {
      json(res, 200, {
        账号: store.accountCount(),
        存档: store.saveCount(),
        房间: manager ? manager.rooms.size : 0,
        数据目录: store.dir,
        备份版本: store.accountsDoc.v,
        t: 1,
      });
      return true;
    }
    if (p === '/admin/export') {
      const bundle = store.exportBundle();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="potato-brawl-backup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(bundle, null, 2) + '\n');
      return true;
    }
    if (p === '/admin/import') {
      if (req.method !== 'POST') { json(res, 405, { error: '用 POST 上传备份 JSON' }); return true; }
      let body;
      try { body = await readBody(req); }
      catch (e) { json(res, 413, { error: '文件太大：' + e.message }); return true; }
      let doc;
      try { doc = JSON.parse(body); }
      catch (e) { json(res, 400, { error: '不是合法 JSON：' + e.message }); return true; }
      let savedAs = '';
      if (url.searchParams.get('merge') !== '1') {
        // 覆盖式还原：先把当前数据留一份，出事能回滚
        savedAs = path.join(store.dir, `backup-before-import-${Date.now()}.json`);
        try { fs.writeFileSync(savedAs, JSON.stringify(store.exportBundle(), null, 2) + '\n'); }
        catch (e) { json(res, 500, { error: '写回滚备份失败，已中止导入：' + e.message }); return true; }
      }
      let result;
      try { result = store.importBundle(doc, { merge: url.searchParams.get('merge') === '1' }); }
      catch (e) { json(res, 400, { error: e.message, rollback: savedAs }); return true; }
      // flush 的返回值必须看：写不进去（盘满 / 权限 / 文件被占用）时内存已经是新数据、
      // 盘上还是旧数据，重启就悄悄回滚了。这时候不能回 200 说「还原完成」
      const flushed = await store.flush().catch((e) => ({ ok: false, error: e }));
      const onDisk = !flushed || flushed.ok !== false;
      // 账号文档被整份换掉了：在线连接手里那份对象已经是孤儿，继续改资料/记战绩会写进
      // 一个没人引用的对象（看着成功，其实丢了）—— 让服务器按用户名重新绑一次
      let rebound = null;
      if (afterImport) { try { rebound = afterImport(); } catch (e) { rebound = { error: String(e && e.message) }; } }
      if (!onDisk) {
        const detail = flushed && flushed.errors
          ? Object.entries(flushed.errors).map(([k, e]) => `${k}：${e.code || e.message}`).join('，')
          : '';
        const why = detail || (flushed && flushed.error && (flushed.error.code || flushed.error.message)) || '未知错误';
        json(res, 500, {
          ok: false,
          writtenToDisk: false,
          error: `导入已在内存里生效，但没能写进磁盘（${why}）：现在重启会退回旧数据。`
            + `清掉盘满/权限问题后再点一次「强制落盘」，或先导出当前状态自己留一份`,
          imported: result, fixedAccounts: result.fixed || 0, rollback: savedAs || null, sessions: rebound,
          failed: (flushed && flushed.failed) || [],
        });
        return true;
      }
      json(res, 200, { ok: true, writtenToDisk: true, imported: result, rollback: savedAs || null, sessions: rebound });
      return true;
    }
    if (p === '/admin/flush') {
      const r = await store.flush().catch((e) => ({ ok: false, error: e }));
      const okFlush = !r || r.ok !== false;
      json(res, okFlush ? 200 : 500, {
        ok: okFlush,
        wrote: (r && r.wrote) || [],
        error: okFlush ? null : String((r && r.error && (r.error.code || r.error.message)) || '写入失败'),
      });
      return true;
    }
    json(res, 404, { error: 'no such admin route' });
    return true;
  };
}
