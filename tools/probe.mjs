// tools/probe.mjs — 布局探针（用真实浏览器测量几何尺寸）
// 用法: node tools/probe.mjs
//
// 为什么需要它：check.mjs 只看语法与内容，sim.mjs 只在 DOM 桩里跑逻辑。
// 两者都发现不了「CSS 写错导致元素根本不显示」这类问题。
//
// 这个探针开发时抓到过一个真实 bug：报告页分类进度条的 .fill 是行内 <span>，
// 行内元素上的 width/height 会被浏览器直接忽略，于是所有进度条宽度都是 0——
// 逻辑完全正常，但用户什么都看不到。
//
// 原理：往页面里注入一段脚本，让它自己测量关键元素的 getBoundingClientRect，
// 用 base64 塞进 DOM，再用无头浏览器的 --dump-dom 把结果导出来断言。
//
// 需要本机有 Edge 或 Chrome。找不到就跳过（exit 0），不影响其它检查。

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'index.html');

/* ---------- 找浏览器 ---------- */
function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const cands = [
    join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Google/Chrome/Application/chrome.exe'),
    local && join(local, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return cands.find(p => { try { return existsSync(p); } catch { return false; } }) || null;
}

const browser = findBrowser();
if (!browser) {
  console.log('[probe] 本机没找到 Edge / Chrome，跳过布局探针（不影响其余检查）');
  process.exit(0);
}

/* ---------- 注入测量脚本 ---------- */
const probeJS = `
<script>
(function(){
  function R(el){ if(!el) return null; var r = el.getBoundingClientRect();
    return {w:Math.round(r.width), h:Math.round(r.height), right:Math.round(r.right)}; }
  var out = { innerW: window.innerWidth, states:{} };
  function overflow(){
    var bad = [];
    document.querySelectorAll('*').forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1)
        bad.push((el.id ? '#'+el.id : el.className || el.tagName) + ' right=' + Math.round(r.right));
    });
    return bad.slice(0, 8);
  }
  var vis = function(id){ return !document.getElementById(id).classList.contains('hidden'); };

  out.states.start = {
    startVisible: vis('screen-start'), gameHidden: !vis('screen-game'), endHidden: !vis('screen-end'),
    btnStart: R(document.getElementById('btnStart')),
    selects: document.querySelectorAll('select').length,
    overflow: overflow()
  };

  document.getElementById('btnStart').click();
  requestAnimationFrame(function(){
    var o = document.querySelectorAll('#options .opt');
    var pick = 0;
    for (var i = 0; i < o.length; i++){ if (curOpts[i].v !== 2){ pick = i; break; } }
    o[pick].click();
    out.states.game = {
      gameVisible: vis('screen-game'),
      minimap: R(document.getElementById('minimap')),
      optCount: o.length,
      optHeights: Array.prototype.map.call(o, function(b){ return R(b).h; }),
      optRightMax: Math.max.apply(null, Array.prototype.map.call(o, function(b){ return R(b).right; })),
      timerText: document.getElementById('timerText').textContent,
      timerTransform: document.getElementById('timerBar').style.transform,
      feedbackRows: document.querySelectorAll('#feedback .row').length,
      verdict: (document.querySelector('#feedback .verdict') || {}).textContent || '',
      nextBtn: R(document.getElementById('btnNext')),
      legendItems: document.querySelectorAll('.legend > div').length,
      bgDots: document.querySelectorAll('#minimap circle').length,
      overflow: overflow()
    };

    for (var q = 0; q < 80; q++){
      if (vis('screen-end')) break;
      var oo = document.querySelectorAll('#options .opt');
      if (!oo.length) break;
      oo[Math.floor(Math.random()*oo.length)].click();
      var nb = document.getElementById('btnNext'); if(!nb) break;
      nb.click();
    }
    var fills = document.querySelectorAll('#report .fill');
    var tracks = document.querySelectorAll('#report .track');
    out.states.report = {
      endVisible: vis('screen-end'),
      reportHeight: R(document.getElementById('report')).h,
      barRows: document.querySelectorAll('#report .barrow').length,
      fillWidths: Array.prototype.map.call(fills, function(f){ return R(f).w; }),
      trackWidths: Array.prototype.map.call(tracks, function(f){ return R(f).w; }),
      statCards: document.querySelectorAll('#report .stat').length,
      hasGrade: document.getElementById('report').textContent.indexOf('评级') >= 0,
      overflow: overflow()
    };

    var pre = document.createElement('pre');
    pre.id = '__probe';
    pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
    document.body.appendChild(pre);
  });
})();
</script>
`;

const dir = mkdtempSync(join(tmpdir(), 'jungle-iq-probe-'));
const page = join(dir, 'probe.html');
writeFileSync(page, readFileSync(SRC, 'utf8').replace('</body>', probeJS + '</body>'), 'utf8');

/* ---------- 跑无头浏览器 ---------- */
const url = 'file:///' + page.replace(/\\/g, '/').replace(/^\//, '');
let dump = '';
try {
  dump = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + join(dir, 'profile'),
    '--virtual-time-budget=5000', '--window-size=900,1200',
    '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.log('[probe] 无头浏览器启动失败，跳过布局探针');
  console.log('        （如果是在受限沙箱里运行，Chromium 依赖命名管道，会被拦下——这属于预期）');
  process.exit(0);
}

const m = dump.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('[probe] ✗ 没拿到探针数据，页面脚本可能没跑完');
  process.exit(1);
}
const d = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8'));

/* ---------- 断言 ---------- */
let failed = 0;
const ok = (label, pass, extra = '') => {
  console.log((pass ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''));
  if (!pass) failed++;
};

const s = d.states.start, g = d.states.game, r = d.states.report;
console.log(`视口 ${d.innerW}px\n`);
console.log('【开始页】');
ok('只有开始页可见', s.startVisible && s.gameHidden && s.endHidden);
ok('开始按钮尺寸正常', s.btnStart && s.btnStart.w > 60 && s.btnStart.h > 30,
   s.btnStart ? `${s.btnStart.w}x${s.btnStart.h}` : 'null');
ok('三个下拉选择器都在', s.selects === 3, String(s.selects));
ok('没有元素横向溢出视口', s.overflow.length === 0, s.overflow.join(' | '));

console.log('\n【答题页】');
ok('进入了答题页', g.gameVisible);
ok('小地图渲染出来了', g.minimap && g.minimap.w >= 180 && g.minimap.h >= 180,
   g.minimap ? `${g.minimap.w}x${g.minimap.h}` : 'null');
ok('小地图画了基地/野怪等底图元素', g.bgDots >= 8, g.bgDots + ' 个圆');
ok('渲染出 4 个选项', g.optCount === 4, String(g.optCount));
ok('每个选项高度够大（可点击）', Math.min(...g.optHeights) >= 34, '高度 ' + g.optHeights.join('/'));
ok('选项没有超出视口右边界', g.optRightMax <= d.innerW + 1, '最右 ' + g.optRightMax);
ok('倒计时条在工作', /scaleX/.test(g.timerTransform || '') && /秒/.test(g.timerText || ''),
   (g.timerTransform || '(空)') + ' / ' + (g.timerText || '(空)'));
ok('反馈面板给出「你选的」与「最优解」两段对照', g.feedbackRows >= 2, g.feedbackRows + ' 段');
ok('反馈面板有判定结论', g.verdict.length > 0, JSON.stringify(g.verdict.trim()));
ok('「下一题」按钮存在', g.nextBtn && g.nextBtn.w > 60, g.nextBtn ? `${g.nextBtn.w}x${g.nextBtn.h}` : 'null');
ok('图例条目齐全', g.legendItems === 6, String(g.legendItems));
ok('没有元素横向溢出视口', g.overflow.length === 0, g.overflow.join(' | '));

console.log('\n【复盘报告页】');
ok('走到了报告页', r.endVisible);
ok('报告内容有高度', r.reportHeight > 400, r.reportHeight + 'px');
ok('评级 / 统计卡 / 分类进度条都生成了',
   r.hasGrade && r.statCards >= 5 && r.barRows >= 3,
   `评级=${r.hasGrade} 统计卡=${r.statCards} 分类条=${r.barRows}`);
ok('进度条容器有宽度', r.trackWidths.length > 0 && Math.min(...r.trackWidths) > 20,
   '容器 ' + r.trackWidths.join('/'));
// 这一条就是当初抓到 .fill 行内 span bug 的断言
ok('每条分类进度条都有可见宽度（不是 0）',
   r.fillWidths.length > 0 && Math.min(...r.fillWidths) > 0, '填充 ' + r.fillWidths.join('/'));
ok('没有元素横向溢出视口', r.overflow.length === 0, r.overflow.join(' | '));

console.log('');
console.log(failed ? `[probe] ${failed} 项未通过` : '[probe] 布局全部通过');
process.exitCode = failed ? 1 : 0;