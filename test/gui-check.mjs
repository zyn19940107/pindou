// GUI 静态自检：改 gui/index.html 或 serve.mjs 的参数映射后跑一下。
// 防的是两类静默故障——
//   1. JS 语法错误 → 页面白屏，但浏览器控制台才有提示；
//   2. 表单字段名和 serve.mjs 的 P 映射对不上 → 参数不报错、只是不生效，
//      比如把 sharpen 拼成 sharp，用户以为锐化了其实没锐化。
import fs from 'node:fs';
import vm from 'node:vm';

const h = fs.readFileSync(new URL('../gui/index.html', import.meta.url), 'utf8');
const blocks = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) throw new Error('没找到 script 块');
blocks.forEach((b, i) => {
  new vm.Script(b[1], { filename: `gui#script${i}` });
  console.log(`script[${i}] 编译通过 (${b[1].split('\n').length} 行)`);
});

const ids = [...h.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log(`元素 id 共 ${ids.length} 个${dup.length ? `，重复: ${dup.join(',')}` : '，无重复'}`);

const used = [...h.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
const missing = [...new Set(used)].filter((x) => !ids.includes(x));
console.log(missing.length ? `JS 引用了不存在的 id: ${missing.join(',')}` : `JS 引用的 ${new Set(used).size} 个 id 全部存在`);

const named = [...h.matchAll(/<(?:input|select)[^>]*name="([\w-]+)"/g)].map((m) => m[1]);
console.log(`表单字段 ${named.length} 个: ${named.join(' ')}`);

const s = fs.readFileSync(new URL('../serve.mjs', import.meta.url), 'utf8');
const pBlock = s.match(/const P = \{([\s\S]*?)\};/);
const keys = [...pBlock[1].matchAll(/(\w+):\s*'--/g)].map((m) => m[1]);
const orphan = [...new Set(named)].filter((n) => !keys.includes(n));
console.log(`后端映射 ${keys.length} 个`);
console.log(orphan.length ? `前端有字段没被后端接收(会静默失效): ${orphan.join(',')}` : '前端字段全部有后端映射');