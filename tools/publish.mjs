// tools/publish.mjs — 通过 GitHub REST API 把本站发布到 GitHub Pages
// 用法:  node tools/publish.mjs
//
// 为什么不用 git：这台机器上没有装 git / gh。
// GitHub 的 Contents API 可以直接提交文件，效果与 push 等价。
//
// 注：若本机 TLS 证书链校验失败，请用系统证书库运行：
//     node --use-system-ca tools/publish.mjs
// （脚本开头有预检，会自动提示这一点）
//
// Token 来源（按优先级）：
//   1) 环境变量 GH_TOKEN
//   2) 工作区里的 _token.txt（仅本地使用，绝不要提交进仓库）
//
// 脚本不会打印 token 本身。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------- 配置 ---------- */
const OWNER  = process.env.GH_OWNER  || 'Nine-Crane';
const REPO   = process.env.GH_REPO   || 'jungle-iq';
const BRANCH = process.env.GH_BRANCH || 'main';
const DESC   = '把《王者荣耀》打野的取舍压缩成限时情景题：几秒内选出最优解，答完立刻告诉你为什么。';
const MARK   = '打野判断力';          // 线上内容校验用的关键词

// 刻意只发布必要的文件，避免把工作区里的 token / 临时文件带上线
const FILES = [
  'index.html',
  'README.md',
  'LICENSE',
  '.gitignore',
  'tools/check.mjs',
  'tools/sim.mjs',
  'tools/probe.mjs',
  'tools/publish.mjs'
];

/* ---------- token ---------- */
// token 文件有两个坑：
//   1) 可能是 UTF-16LE（Windows 记事本另存为的常见结果，带 FF FE BOM）。
//      按 UTF-8 读会得到交错的 \0 字节，长度翻倍且全是非法字符，
//      现象是 Authorization header 直接抛 ERR_INVALID_CHAR。
//   2) 常带首尾换行、零宽字符。
// 所以这里做编码嗅探 + 字符清洗。
function decodeTokenFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.toString('utf16le', 2);              // UTF-16LE + BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.subarray(2));   // UTF-16BE + BOM
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);                 // UTF-8 + BOM
  }
  // 无 BOM：出现大量 \0 基本可判定为 UTF-16LE
  const nulCount = buf.subarray(0, Math.min(buf.length, 64)).filter(b => b === 0).length;
  return nulCount > 8 ? buf.toString('utf16le') : buf.toString('utf8');
}
function cleanToken(raw) {
  return String(raw)
    .replace(/^\uFEFF/, '')                  // BOM
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // 零宽字符
    .replace(/\s+/g, '');                    // 所有空白（含换行/制表）
}
function loadToken() {
  if (process.env.GH_TOKEN) {
    const t = cleanToken(process.env.GH_TOKEN);
    if (t) return t;
  }
  for (const p of [
    join(ROOT, '..', '_token.txt'),
    join(ROOT, '_token.txt')
  ]) {
    if (existsSync(p)) {
      const t = cleanToken(decodeTokenFile(readFileSync(p)));
      if (t) return t;
    }
  }
  throw new Error('找不到 GitHub token：请设置 GH_TOKEN，或把 token 放到工作区的 _token.txt');
}
const TOKEN = loadToken();
if (!/^[A-Za-z0-9_.\-]+$/.test(TOKEN)) {
  throw new Error('token 清洗后仍含非法字符，长度=' + TOKEN.length);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- TLS 预检 ---------- */
// 有些机器（公司网络 / 代理 / 装了自签根证书的杀软）装了 Node 默认不信任的根证书，
// 现象是后面所有请求都以 UNABLE_TO_VERIFY_LEAF_SIGNATURE 失败、只丢一堆堆栈。
// 这里提前检出来，直接告诉用户该怎么跑。
try {
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/', method: 'HEAD',
      headers: { 'User-Agent': 'jungle-iq-publish' }
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
} catch (e) {
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify|self.signed|SELF_SIGNED/i.test(e.message)) {
    console.error('\n[预检失败] 无法验证 TLS 证书链。');
    console.error('本机很可能装了 Node 默认不信任的根证书（公司网络 / 代理 / 杀毒软件都可能）。');
    console.error('解决办法是用系统证书库重跑：');
    console.error('\n    node --use-system-ca tools/publish.mjs\n');
    process.exit(1);
  }
  // 其它网络问题留给后面的正式请求去报，这里不拦
}

/* ---------- HTTP ---------- */
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'jungle-iq-publish',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { /* 可能是空响应 */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'jungle-iq-check', 'Cache-Control': 'no-cache' }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

/* ---------- 步骤 1：校验 token ---------- */
const me = await api('GET', '/user');
if (me.status !== 200) {
  throw new Error('token 无效或权限不足 (HTTP ' + me.status + '): ' + (me.body && me.body.message));
}
const login = me.body.login;
console.log('[1/5] token 有效，账号:', login);
if (login !== OWNER) {
  console.log('      注意：token 属于 ' + login + '，但目标 owner 配的是 ' + OWNER);
}

/* ---------- 步骤 2：确保仓库存在 ---------- */
const repoPath = `/repos/${OWNER}/${REPO}`;
const repo = await api('GET', repoPath);
if (repo.status === 404) {
  const created = await api('POST', '/user/repos', {
    name: REPO,
    description: DESC,
    private: false,
    auto_init: true
  });
  if (created.status !== 201) {
    throw new Error('创建仓库失败: ' + created.status + ' ' + JSON.stringify(created.body));
  }
  console.log('[2/5] 仓库已创建:', OWNER + '/' + REPO);
  await sleep(2500);
} else if (repo.status === 200) {
  console.log('[2/5] 仓库已存在:', OWNER + '/' + REPO);
} else {
  throw new Error('查询仓库失败: ' + repo.status + ' ' + (repo.body && repo.body.message));
}

/* ---------- 步骤 3：提交文件 ---------- */
console.log('[3/5] 提交文件…');
let uploaded = 0;
for (const rel of FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.log('      跳过（不存在）:', rel);
    continue;
  }
  const content = Buffer.from(readFileSync(abs, 'utf8'), 'utf8').toString('base64');
  const path = `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel).replace(/%2F/g, '/')}`;

  // 已存在则带上 sha 以覆盖
  const existing = await api('GET', `${path}?ref=${BRANCH}`);
  const body = { message: `chore: publish ${rel}`, content, branch: BRANCH };
  if (existing.status === 200 && existing.body && existing.body.sha) body.sha = existing.body.sha;

  const put = await api('PUT', path, body);
  if (put.status === 200 || put.status === 201) {
    uploaded++;
    console.log('      ✓', rel);
  } else {
    throw new Error('提交失败 ' + rel + ': ' + put.status + ' ' + JSON.stringify(put.body));
  }
  await sleep(350);   // 轻微节流，避免触发 secondary rate limit
}
console.log('      共提交', uploaded, '个文件');

/* ---------- 步骤 4：开启 GitHub Pages ---------- */
// 先 GET 查询再决定，不要直接 PATCH：
// 对已经配置好的 Pages 发 PATCH，GitHub 会返回 404 Not Found，
// 于是每次重发都会打出一条"配置返回 404"的误导性警告——站点其实是好的。
console.log('[4/5] 配置 GitHub Pages…');
const current = await api('GET', repoPath + '/pages');
if (current.status === 200) {
  console.log('      Pages 已启用:', (current.body && current.body.url) || '(已配置)');
} else if (current.status === 404) {
  const post = await api('POST', repoPath + '/pages', {
    source: { branch: BRANCH, path: '/' }
  });
  if (post.status === 201 || post.status === 200) {
    console.log('      Pages 已创建:', (post.body && post.body.url) || '(配置成功)');
  } else {
    console.log('      ⚠ Pages 创建返回 ' + post.status + '：' + (post.body && post.body.message));
    console.log('        可稍后在仓库 Settings → Pages 手动选择 ' + BRANCH + '/(root)');
  }
} else {
  console.log('      ⚠ 查询 Pages 配置返回 ' + current.status + '：' + (current.body && current.body.message));
  console.log('        可稍后在仓库 Settings → Pages 手动选择 ' + BRANCH + '/(root)');
}

/* ---------- 步骤 5：等待并验证线上可访问 ---------- */
const URL = `https://${OWNER}.github.io/${REPO}/`;
console.log('[5/5] 等待 Pages 构建并验证:', URL);

let live = false;
for (let i = 1; i <= 30; i++) {
  await sleep(5000);
  const r = await httpGet(URL);
  const good = r.status === 200 && r.body.includes(MARK);
  if (good) {
    live = true;
    console.log(`      第 ${i} 次检查: 200 OK，页面内容已生效 ✓`);
    break;
  }
  console.log(`      第 ${i} 次检查: HTTP ${r.status}，继续等待…`);
}

console.log('\n' + '─'.repeat(60));
console.log('仓库地址 :', `https://github.com/${OWNER}/${REPO}`);
console.log('线上地址 :', URL);
console.log('─'.repeat(60));
if (!live) {
  console.log('页面可能仍在构建中（首次部署通常 1-2 分钟）。稍后刷新上面的线上地址即可。');
  process.exitCode = 2;
} else {
  console.log('发布完成 ✓');
}