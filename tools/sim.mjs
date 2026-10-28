// tools/sim.mjs — 无头模拟器（交付前的行为验证）
// 用法: node tools/sim.mjs [局数]
//
// 静态检查（check.mjs）只能证明语法和题库结构没问题，证明不了"游戏真的能玩"。
// 这个脚本把 index.html 里的内联脚本抽出来，注入一套最小 DOM 桩，
// 然后真的点按钮、真的答题、真的读复盘报告。
//
// 最关键的验证是「位置偏好」：
//   如果玩家闭着眼睛总选第一个选项就能拿高分，说明选项打乱没生效，这个训练器就废了。
//   所以这里专门跑一个 always-first 策略，断言它的得分接近随机水平（约 25%）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
const code = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];

const GAMES = parseInt(process.argv[2], 10) || 200;

let failed = 0;
const ok = (label, pass, extra = '') => {
  console.log((pass ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''));
  if (!pass) failed++;
};

/* ============================================================
   最小 DOM 桩
   ============================================================ */
const OPT_RE = /data-i="(\d+)"><span class="key">[^<]*<\/span><span class="txt">([\s\S]*?)<\/span><\/button>/g;

class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this._h = {};
    this._cls = new Set();
    const cls = this._cls;
    this.classList = {
      add: (...c) => c.forEach(x => cls.add(x)),
      remove: (...c) => c.forEach(x => cls.delete(x)),
      contains: c => cls.has(c),
    };
  }
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    if (this.id === 'options') {
      for (const m of v.matchAll(OPT_RE)) {
        const b = new El('opt-' + m[1]);
        b.dataset.i = m[1];
        b._text = m[2];
        this.children.push(b);
      }
    }
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  querySelectorAll(sel) { return sel === '.opt' ? this.children : []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
  fire(ev, arg) { (this._h[ev] || []).forEach(fn => fn(arg || { preventDefault() {} })); }
  focus() {}
}

const els = new Map();
const el = id => {
  if (!els.has(id)) els.set(id, new El(id));
  return els.get(id);
};
// 初始状态：这两个屏是隐藏的（对应 HTML 里的 class="hidden"）
el('screen-game').classList.add('hidden');
el('screen-end').classList.add('hidden');

// 可控时钟，用来驱动倒计时（真实 rAF 在无头环境里跑不起来）
let clock = 0;
let rafQ = [];
const sandbox = {
  document: {
    getElementById: el,
    createElement: () => new El('tmp'),
    addEventListener: (ev, fn) => { if (ev === 'keydown') sandbox.__keydown = fn; },
  },
  performance: { now: () => clock },
  requestAnimationFrame: cb => { rafQ.push(cb); return rafQ.length; },
  cancelAnimationFrame: () => { rafQ = []; },
  window: { scrollTo() {} },
  Math, JSON, String, Number, Array, Object, parseInt, parseFloat, isNaN, console,
};
function advance(ms) {
  clock += ms;
  const q = rafQ; rafQ = [];
  q.forEach(cb => cb());
}

/* 可控随机数（固定种子），保证回归结果可复现、不会偶发飘红 */
let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
sandbox.Math = Object.create(Math);
sandbox.Math.random = rnd;

/* ============================================================
   启动游戏脚本
   ============================================================ */
let bootErr = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'index.html<script>' });
} catch (e) { bootErr = e; }
ok('游戏脚本能在 DOM 桩里启动', !bootErr, bootErr ? bootErr.message : '');

/* 拿到题库，用来构造「满分玩家」策略 */
const bank = new Function('return ' + src.match(/const BANK = (\[[\s\S]*?\n\]);/)[1])();
const bestTexts = new Set(bank.map(s => s.opts.find(o => o.v === 2).t));
ok('每道题的最优解文案互不重复（可用作文本指纹）', bestTexts.size === bank.length,
   bestTexts.size + '/' + bank.length);

/* ============================================================
   一局模拟
   ============================================================ */
// strategy: 'first' | 'random' | 'best' | 'timeout'
function playOne(strategy, limitMs = 12000, count = 0, reactMs = 0) {
  el('selLimit').value = String(limitMs);
  el('selCount').value = String(count);
  el('selOrder').value = 'random';
  // 重置屏幕状态
  el('screen-start').classList.remove('hidden');
  el('screen-game').classList.add('hidden');
  el('screen-end').classList.add('hidden');

  el('btnStart').fire('click');
  if (el('screen-game').classList.contains('hidden')) throw new Error('点击开始后没有进入游戏页');

  let guard = 0;
  const bestPositions = [];
  let nBest = 0, nOk = 0, nBad = 0, nTimeout = 0;

  while (el('screen-end').classList.contains('hidden')) {
    if (++guard > 500) throw new Error('回合数异常，可能死循环');

    const opts = el('options').children;
    if (!opts.length) throw new Error('题目没有渲染出选项');

    if (strategy === 'timeout') {
      advance(limitMs + 1000);            // 不点，等它超时
      nTimeout++;
    } else {
      // 模拟"思考了 reactMs 才作答"，用来检验时间奖励确实随剩余时间变化
      if (reactMs) advance(reactMs);
      let pick = 0;
      if (strategy === 'random') pick = Math.floor(rnd() * opts.length);
      if (strategy === 'best') pick = opts.findIndex(o => bestTexts.has(o._text));
      if (pick < 0) throw new Error('找不到最优解选项，题目渲染可能有问题');
      opts[pick].fire('click');
    }

    // 结算：读游戏自己打上的判定 class
    const picked = opts.find(o => o.classList.contains('pick'));
    const bestOne = opts.find(o => o.classList.contains('best'));
    if (bestOne) bestPositions.push(opts.indexOf(bestOne));
    if (strategy !== 'timeout') {
      if (picked.classList.contains('best')) nBest++;
      else if (picked.classList.contains('ok')) nOk++;
      else nBad++;
    }

    el('btnNext').fire('click');
  }
  return { bestPositions, nBest, nOk, nBad, nTimeout, score: parseInt(el('scoreVal').textContent, 10) };
}

/* ============================================================
   1) 位置偏好检验 —— 本项目最核心的设计前提
   ============================================================ */
console.log('\n【位置偏好检验】');
const runs = [];
for (let i = 0; i < GAMES; i++) runs.push(playOne('first', 12000, 0));

const allPos = runs.flatMap(r => r.bestPositions);
ok('每局都记录了最优解的位置', allPos.length === GAMES * bank.length,
   allPos.length + ' / ' + (GAMES * bank.length));

const dist = [0, 0, 0, 0];
allPos.forEach(p => dist[p]++);
const pct = dist.map(d => d / allPos.length * 100);
const maxDev = Math.max(...pct.map(p => Math.abs(p - 25)));
ok('最优解在 4 个位置上分布均匀（打乱生效）', maxDev < 4,
   'A/B/C/D = ' + pct.map(p => p.toFixed(1) + '%').join(' / '));

const totalQ = runs.reduce((a, r) => a + r.nBest + r.nOk + r.nBad, 0);
const firstBest = runs.reduce((a, r) => a + r.nBest, 0);
const firstAcc = firstBest / totalQ * 100;
ok('「无脑总选第一个」拿不到高分（≈25%，即随机水平）', firstAcc > 19 && firstAcc < 31,
   '最优率 ' + firstAcc.toFixed(1) + '%');

/* ============================================================
   2) 满分玩家与随机玩家
   ============================================================ */
console.log('\n【策略对照】');
const nPer = 40;
const acc = { best: [], random: [], first: [] };
for (let i = 0; i < nPer; i++) {
  acc.best.push(playOne('best', 12000, 0));
  acc.random.push(playOne('random', 12000, 0));
}
const rate = rs => {
  const t = rs.reduce((a, r) => a + r.nBest + r.nOk + r.nBad, 0);
  return rs.reduce((a, r) => a + r.nBest, 0) / t * 100;
};
const bestRate = rate(acc.best);
const randRate = rate(acc.random);
ok('选最优解的玩家命中 100% 最优', bestRate === 100, '最优率 ' + bestRate.toFixed(1) + '%');
ok('随机乱选的玩家 ≈25%（与「总选第一个」同档）', randRate > 19 && randRate < 31,
   '最优率 ' + randRate.toFixed(1) + '%');
ok('满分玩家得分显著高于随机玩家',
   acc.best[0].score > acc.random[0].score * 2,
   '满分 ' + acc.best[0].score + ' vs 随机 ' + acc.random[0].score);

/* ============================================================
   3) 倒计时与超时
   ============================================================ */
console.log('\n【倒计时 / 超时】');
const to = playOne('timeout', 6000, 10);
ok('超时会自动结算并允许继续', to.nTimeout === 10 && to.score === 0,
   '超时 ' + to.nTimeout + ' 题，得分 ' + to.score);
ok('超时局也能走到复盘报告', !el('screen-end').classList.contains('hidden'));

// 同样的反应时间（3 秒）下，限时越短 → 剩余时间占比越小 → 时间奖励越少
const fast = playOne('best', 6000, 24, 3000);
const slow = playOne('best', 12000, 24, 3000);
ok('同样反应速度下，限时越短时间奖励越少', fast.score < slow.score,
   '6s 限时得分 ' + fast.score + ' < 12s 限时得分 ' + slow.score);
// 反过来：限时相同时，答得越快拿的时间奖励越高
const quick = playOne('best', 12000, 24, 500);
const lazy  = playOne('best', 12000, 24, 6000);
ok('限时相同下，答得越快奖励越高', quick.score > lazy.score,
   '快答 ' + quick.score + ' > 慢答 ' + lazy.score);

/* ============================================================
   4) 复盘报告内容
   ============================================================ */
console.log('\n【复盘报告】');
const rep = el('report').innerHTML;
for (const [label, key] of [
  ['包含评级', '评级'],
  ['包含最优解统计', '最优解'],
  ['包含分类准确率', '各类情境的判断准确率'],
  ['包含针对性建议', '给你的针对性建议'],
]) ok(label, rep.includes(key));

const mixed = playOne('random', 12000, 24);
ok('有错题时生成错题复盘', el('report').innerHTML.includes('错题复盘') || mixed.nOk + mixed.nBad === 0);

console.log('');
console.log(`跑了 ${GAMES + nPer * 2 + 4} 局。`);
console.log(failed ? `[sim] ${failed} 项未通过` : '[sim] 全部通过');
process.exitCode = failed ? 1 : 0;