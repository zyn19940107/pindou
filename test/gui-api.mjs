// GUI 后端 API 回归：自己起一个临时实例，测完自己关掉，不留后台进程。
// 覆盖三件事：
//   1. /api/palettes 的色数与 palettes/*.json 实际条数一致（防止前端显示假数字）
//   2. maxColors 调小确实让实际用色数下降（k-means 的 K 真的生效）
//   3. 上传→生成整条链路可用
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/palettes`); if (r.ok) return; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务 12 秒内没就绪');
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${j.error || r.status}`);
  return j;
};

const srv = spawn(process.execPath, ['serve.mjs', 'out', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
let failed = 0;
try {
  await waitReady();

  // 1) 色卡色数必须与文件实际条数一致
  const pals = await (await fetch(`${BASE}/api/palettes`)).json();
  console.log('=== 色卡 ===');
  for (const [k, v] of Object.entries(pals)) {
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'palettes', `${k}.json`), 'utf8')).colors.length;
    const ok = real === v.count;
    if (!ok) failed++;
    console.log(`  ${k}: 接口 ${v.count} / 文件 ${real} ${ok ? 'OK' : '不一致!'}`);
  }

  // 2) 上传 + 不同用色上限，看实际用色数是否随之下降
  const img = fs.readFileSync(path.join(ROOT, 'input', 'cat_benben.jpg'));
  const up = await post('/api/upload', { name: 'cat_benben.jpg', data: img.toString('base64') });
  console.log('\n=== 用色数量 (maxColors -> 实际用色) ===');
  let prev = Infinity;
  for (const n of [4, 12, 24, 99]) {
    const r = await post('/api/generate', {
      path: up.path,
      params: { size: '40', palette: 'midi', maxColors: String(n), bg: 'auto', scale: '8' },
    });
    const used = r.meta.colors.filter((c) => c.count > 0).length;
    const within = used <= n ? 'OK' : '超出上限!';
    // 用色数应随上限增大而不减；但不该断言「等于上限」——
    // k 是聚类中心数，图片本身没有那么多层颜色时空簇会被丢，实际用色天然少于上限。
    // 实测同一张猫图：上限 4/12/24/99 -> 实际 4/8/10/12。
    if (used > n || (prev !== Infinity && used < prev)) failed++;
    console.log(`  上限 ${String(n).padStart(2)} -> 实际 ${used} 种 ${within}`);
    prev = used;
  }
} catch (e) {
  failed++;
  console.error('失败:', e.message);
} finally {
  srv.kill();
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);