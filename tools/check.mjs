// tools/check.mjs — 交付前静态自检
// 用法: node tools/check.mjs
//
// 这个项目的「内容」本身就是产品，所以除了常规的语法 / DOM 检查之外，
// 还要对题库做结构校验：每道题必须恰好有一个最优解、四个选项、以及足够长的解释。
// 题库写错的代价很高（玩家学到的就是错的），所以这层检查是必须的。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

let failed = 0;
const ok = (label, pass, extra = '') => {
  console.log((pass ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''));
  if (!pass) failed++;
};

/* ---------- 1) 内联脚本语法 ---------- */
const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
ok('存在内联脚本', blocks.length > 0, `(${blocks.length} 个)`);
const code = blocks.length ? blocks[blocks.length - 1][1] : '';
let syntaxError = null;
try { new Function(code); } catch (e) { syntaxError = e; }
ok('内联脚本语法有效', !syntaxError, syntaxError ? syntaxError.message : '');

/* ---------- 2) DOM id 完整性 ---------- */
const REQUIRED_IDS = [
  'screen-start', 'screen-game', 'screen-end',
  'selLimit', 'selCount', 'selOrder', 'btnStart',
  'qIndex', 'qTotal', 'scoreVal', 'streakVal',
  'timerBar', 'timerText',
  'catTag', 'timeTag', 'qTitle', 'qDesc', 'minimap', 'options', 'feedback',
  'report', 'btnRestart', 'btnHome'
];
const missing = REQUIRED_IDS.filter(id => !src.includes(`id="${id}"`));
ok('所有必需的 DOM id 都存在', missing.length === 0, missing.join(', '));

// btnNext 是答题后动态插入的，不在静态 HTML 里，属于预期的例外
const DYNAMIC_IDS = new Set(['btnNext']);
const used = [...new Set([...src.matchAll(/byId\('([^']+)'\)/g)].map(m => m[1]))];
const dead = used.filter(id => !DYNAMIC_IDS.has(id) && !src.includes(`id="${id}"`));
ok('byId 引用的 id 全部有对应元素', dead.length === 0, dead.join(', '));

/* ---------- 3) 题库结构校验（这个项目的核心资产） ---------- */
const CATS = ['开局', '节奏', 'Gank', '反野', '资源', '团战', '逃生'];
let bank = null;
const mBank = src.match(/const BANK = (\[[\s\S]*?\n\]);/);
if (mBank) {
  try { bank = new Function('return ' + mBank[1])(); } catch (e) {
    ok('题库可以被解析', false, e.message);
  }
}
ok('题库可以被解析', Array.isArray(bank) && bank.length > 0, bank ? `(${bank.length} 道题)` : '未找到 BANK');
ok('题库规模足够（>=20 道）', !!bank && bank.length >= 20, bank ? bank.length + ' 道' : '');

if (Array.isArray(bank)) {
  const badCat = bank.filter(s => !CATS.includes(s.cat)).map(s => s.q);
  ok('每道题的 cat 都是已知类型', badCat.length === 0, badCat.join(' / '));

  const badCount = bank.filter(s => !Array.isArray(s.opts) || s.opts.length !== 4).map(s => s.q);
  ok('每道题恰好 4 个选项', badCount.length === 0, badCount.join(' / '));

  const badBest = bank.filter(s => s.opts.filter(o => o.v === 2).length !== 1).map(s => s.q);
  ok('每道题恰好有 1 个最优解(v=2)', badBest.length === 0, badBest.join(' / '));

  const badV = bank.filter(s => s.opts.some(o => ![0, 1, 2].includes(o.v))).map(s => s.q);
  ok('选项分值只用 0/1/2', badV.length === 0, badV.join(' / '));

  const badWhy = [];
  bank.forEach(s => s.opts.forEach(o => {
    if (!o.why || o.why.length < 25) badWhy.push(s.q + ' → ' + (o.t || '').slice(0, 14));
  }));
  ok('每个选项都有足够详细的解释(>=25字)', badWhy.length === 0, badWhy.slice(0, 3).join(' / '));

  const noText = bank.filter(s => !s.q || !s.d || !s.t).map(s => s.q || '(无标题)');
  ok('题干/描述/时间点都不为空', noText.length === 0, noText.join(' / '));

  const covered = CATS.filter(c => bank.some(s => s.cat === c));
  ok('七个类别全部覆盖', covered.length === CATS.length, '缺: ' + CATS.filter(c => !covered.includes(c)).join(', '));

  // 选项顺序必须在渲染时打乱。
  // 题库里最优解的原始位置集中在哪不重要——但如果渲染时不打乱，
  // 玩家闭着眼睛总选 A 就能拿高分，这个训练器就废了。
  ok('渲染时打乱了选项顺序（消除位置偏好）',
     /curOpts\s*=\s*shuffle\(/.test(code) && /curOpts\.map\(/.test(code));

  // 打乱之后，作答和复盘必须沿用同一份顺序，否则会把解释安到错误的选项上
  ok('作答与复盘沿用打乱后的顺序',
     !/s\.opts\[i\]\.why/.test(code) && !/s\.opts\[r\.i\]/.test(code) && /disp:\s*opts/.test(code));
}

/* ---------- 4) 常见低级错误 ---------- */
ok('没有残留的调试打印', !/console\.log\(/.test(code));
ok('没有未闭合的模板字符串残渣', !/\$\{[^}]*$/.test(code));
ok('没有把收益数值写进选项文案（本项目的设计前提）',
   !bank || !bank.some(s => s.opts.some(o => /\+?\d{2,}\s*(金币|金|分)\b/.test(o.t))));

/* ---------- 5) 交付物 ---------- */
for (const f of ['README.md', 'LICENSE', '.gitignore']) {
  let exist = true;
  try { readFileSync(join(HERE, '..', f)); } catch { exist = false; }
  ok(`交付文件存在: ${f}`, exist);
}

console.log('');
console.log(failed ? `[check] ${failed} 项未通过` : '[check] 全部通过');
process.exitCode = failed ? 1 : 0;