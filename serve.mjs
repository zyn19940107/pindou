#!/usr/bin/env node
// 拼豆本地 Web 界面：node serve.mjs [目录] [端口]
//   /        GUI：拖图 → 自动分析（主体 bbox / 眼部格数）→ 调参 → 出 A4 图纸
//   /out/    产物目录列表（原来的功能，挪到这里给打印前翻查用）
//
// 为什么生成走「spawn 调 gen.mjs」而不是在服务端 import：
// gen.mjs 是顶层脚本，参数直接读 process.argv，30 多个开关都在那儿。
// 复用 CLI 意味着 GUI 和命令行永远同一套行为，不用把逻辑抄第二遍；
// 代价是每次生成多几十毫秒进程启动，对拼豆这种秒级操作无所谓。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectSubjectBBox, detectEyeMetrics, evaluateEyeCells, suggestEyeCrop } from './lib/analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.cwd(), process.argv[2] || 'out');
const port = Number(process.argv[3] || 8765);
const UPLOAD_DIR = path.join(dir, '_upload');
const GUI_DIR = path.join(HERE, 'gui');
const MAX_BODY = 40 * 1024 * 1024;

const types = {
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8',
};

// GUI 传 camelCase，这里翻译成 gen.mjs 的长参数；空值一律不出现在命令行里，
// 免得 --sharpen '' 之类被 parseArgs 吃成字符串后在算术里变成 NaN。
const P = {
  size: '--size', palette: '--palette', title: '--title', maxColors: '--max-colors', mode: '--mode',
  shape: '--shape', cellMm: '--cell-mm',
  crop: '--crop', fit: '--fit', padColor: '--pad-color', buffer: '--buffer', sharpen: '--sharpen',
  bg: '--bg', bgRing: '--bg-ring', bgMode: '--bg-mode',
  bgCut: '--bg-cut', bgCutKeep: '--bg-cut-keep', bgCutDepth: '--bg-cut-depth', bgCutRing: '--bg-cut-ring',
  bgBox: '--bg-box', bgFill: '--bg-fill',
  brightness: '--brightness', contrast: '--contrast', saturation: '--saturation',
  despeckle: '--despeckle', minCount: '--min-count', scale: '--scale', override: '--override',
};

// gen.mjs 的 parseArgs 会把紧跟 --flag 的下一个 token 当成它的值，
// 所以布尔开关一律用 --flag=true：带 = 号时走 inline 分支，不会吞掉后面的参数。
const BOOL_FLAGS = new Set(['--labels', '--no-legend', '--bg-blank', '--bg-outline']);

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { fail(new Error('请求体超过 40MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// 上传文件名不接受用户给的字符串：只保留扩展名，主体用随机 hex，
// 否则 "../" 或绝对路径能直接把文件写到 out 外面去。
const EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

async function handleUpload(req, res) {
  const { name, data } = JSON.parse((await readBody(req)).toString('utf8'));
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!EXT_OK.has(ext)) return json(res, 400, { error: `只支持 ${[...EXT_OK].join(' / ')}，收到 ${ext || '空扩展名'}` });
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) return json(res, 400, { error: '文件内容为空' });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const file = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(file, buf);
  json(res, 200, { path: file, name: path.basename(file), url: `/out/${path.relative(dir, file).split(path.sep).join('/')}` });
}

// 只接受项目 out/ 里的真实路径，防止前端传 ../../etc/passwd 之类被 gen.mjs 读到
function safeImagePath(p) {
  const abs = path.resolve(HERE, String(p || ''));
  const rel = path.relative(HERE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fs.existsSync(abs) ? abs : null;
}

async function handleAnalyze(req, res) {
  const { path: p, gridSize } = JSON.parse((await readBody(req)).toString('utf8'));
  const img = safeImagePath(p);
  if (!img) return json(res, 400, { error: '图片路径无效' });
  const gs = Math.max(10, Math.min(150, Number(gridSize) || 45));
  const box = await detectSubjectBBox(img);
  const out = { imageW: box.imageW, imageH: box.imageH, bbox: box, gridSize: gs };
  const eye = await detectEyeMetrics(img);
  if (!eye.found) {
    out.eye = { found: false, reason: eye.reason };
    return json(res, 200, out);
  }
  // 把「眼宽 -> 几格」和「要几格得裁多宽」一起给前端，
  // 用户不用自己算：这个工具存在的意义就是替人算清眼睛在成品上够不够大。
  const cropW = box.crop.w;
  out.eye = {
    found: true,
    eyePx: eye.eyePx,
    eyePxMin: eye.eyePxMin,
    box: eye.box,
    confidence: eye.confidence,
    note: eye.note,
    atCrop: evaluateEyeCells(eye.eyePx, cropW, gs),
    atCropMin: evaluateEyeCells(eye.eyePxMin, cropW, gs),
    cropSuggest: [8, 10, 12].map((t) => ({ target: t, ...suggestEyeCrop(eye, gs, t) })),
  };
  json(res, 200, out);
}

function runGen(input, params) {
  return new Promise((ok) => {
    // 输出目录由服务端定，不接受前端指定，否则能把文件写进任意目录
    const outDir = path.join(dir, `gui-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`);
    const args = ['gen.mjs', '--input', input, '--out', outDir];
    for (const [k, flag] of Object.entries(P)) {
      const v = params?.[k];
      if (v === undefined || v === null || v === '' || v === false) continue;
      if (BOOL_FLAGS.has(flag)) { args.push(`${flag}=true`); continue; }
      args.push(flag, String(v));
    }
    const child = spawn(process.execPath, args, { cwd: HERE });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('close', (code) => {
      clearTimeout(timer);
      ok({ code, log: log.trim(), outDir, args });
    });
  });
}

async function handleGenerate(req, res) {
  const { path: p, params } = JSON.parse((await readBody(req)).toString('utf8'));
  const img = safeImagePath(p);
  if (!img) return json(res, 400, { error: '图片路径无效' });
  const r = await runGen(img, params);
  if (r.code !== 0) return json(res, 500, { error: '生成失败', log: r.log });
  const name = path.basename(r.outDir);
  const files = fs.existsSync(r.outDir)
    ? fs.readdirSync(r.outDir).map((f) => ({ name: f, url: `/out/${name}/${f}` }))
    : [];
  const meta = JSON.parse(fs.readFileSync(path.join(r.outDir, 'pattern.json'), 'utf8'));
  json(res, 200, { log: r.log, dir: name, files, meta });
}

// 色卡元信息。色数从 palettes/*.json 现读，不在前端写死——
// 色卡文件一改，硬编码的「73 色」就会变成假话，还会反过来误导 maxColors 的上限。
function readPalettes() {
  const dir2 = path.join(HERE, 'palettes');
  const out2 = {};
  for (const f of fs.existsSync(dir2) ? fs.readdirSync(dir2) : []) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir2, f), 'utf8'));
      out2[path.basename(f, '.json')] = { name: p.name || f, count: (p.colors || []).length };
    } catch { /* 色卡文件坏了不该拖垮整个服务，跳过即可 */ }
  }
  return out2;
}

const outIndex = () => {
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_'));
  const items = dirs.map((d) => {
    const html = path.join(dir, d.name, 'pattern-a4.html');
    const png = path.join(dir, d.name, 'preview.png');
    return `<li><a href="/out/${d.name}/pattern-a4.html">${d.name}</a> ${fs.existsSync(png) ? `<a class="s" href="/out/${d.name}/preview.png">预览图</a>` : ''}${fs.existsSync(html) ? '' : ' <span>（无 A4 图纸）</span>'}</li>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>拼豆产物</title>
<style>body{font-family:-apple-system,"Microsoft YaHei",sans-serif;padding:24px;line-height:1.9;color:#111}
h1{font-size:18px}ul{list-style:none;padding:0}a{color:#1668dc;text-decoration:none}a:hover{text-decoration:underline}
a.s{color:#888;font-size:12px;margin-left:10px}</style></head><body>
<h1>拼豆产物（点名称打开 A4 打印版）</h1><ul>${items}</ul>
<p style="color:#888;font-size:12px">打印：纸张 A4 · 缩放 100% · 勾选背景图形 · <a href="/">回到生成界面</a></p></body></html>`;
};

const sendFile = (res, file) => {
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/oct-stream' });
  fs.createReadStream(file).pipe(res);
};

http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (req.method === 'POST' && url === '/api/upload') return await handleUpload(req, res);
    if (req.method === 'POST' && url === '/api/analyze') return await handleAnalyze(req, res);
    if (req.method === 'POST' && url === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'GET' && url === '/api/palettes') return json(res, 200, readPalettes());
    if (url === '/out' || url === '/out/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(outIndex()); }
    // GUI 静态页
    if (url === '/' || url === '/index.html') {
      const f = path.join(GUI_DIR, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(500).end('gui/index.html 不存在'); return; }
      return sendFile(res, f);
    }
    if (url.startsWith('/out/')) {
      const f = path.join(dir, url.slice(5));
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end('not found'); return; }
      return sendFile(res, f);
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(port, () => console.log(`GUI: http://localhost:${port}/\n产物: http://localhost:${port}/out/  (目录 ${dir})`));