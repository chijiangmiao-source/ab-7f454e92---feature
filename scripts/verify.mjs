// 单次 verify：求解器测试 → 生产构建 → 样例核对（计数/规范补全/见证）→ HTTP 冒烟。
// 全部通过以退出码 0 结束；任一步失败立即非零退出。
//
// HTTP 冒烟两种模式：
//   - Compose：设置 WEB_URL（如 http://web:8080），直接探测已健康的 web 服务；
//   - 本地：未设置 WEB_URL 时，自行以 PORT=SMOKE_PORT 启动静态服务器，探测后关闭。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateInput, solveProblem } from '../src/solver/core.js';

const ROOT = new URL('../', import.meta.url).pathname;
const log = (s) => process.stdout.write(s + '\n');
const fail = (s) => { console.error('✗ ' + s); process.exit(1); };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))));
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

/* ---------- 1. 求解器测试（内含计数、规范补全、见证对拍） ---------- */
log('▶ [1/4] 求解器测试（含穷举对拍、样例计数/规范补全/见证核对）');
await run('node', ['--test', 'test/']);
log('✓ 求解器测试通过\n');

/* ---------- 2. 生产构建 ---------- */
log('▶ [2/4] 生产构建（tsc --noEmit + vite build）');
await run('npm', ['run', 'build']);
log('✓ 构建产物已生成\n');

/* ---------- 3. 固定歧义与冲突样例核对（verify 内独立断言） ---------- */
log('▶ [3/4] 固定歧义/冲突样例核对');
const amb = {
  cellNames: ['A', 'B', 'C', 'D', 'E', 'F'],
  mutNames: ['m0', 'm1', 'm2', 'm3'],
  rows: [
    ['1', '1', '0', '0'],
    ['?', '1', '0', '0'],
    ['1', '0', '1', '0'],
    ['?', '0', '1', '0'],
    ['0', '0', '0', '?'],
    ['?', '0', '0', '0'],
  ],
  costs: [
    [null, null, null, null],
    [{ c0: '9', c1: '0' }, null, null, null],
    [null, null, null, null],
    [{ c0: '9', c1: '0' }, null, null, null],
    [null, null, null, { c0: '0', c1: '0' }],
    [{ c0: '0', c1: '5' }, null, null, null],
  ],
};
{
  const v = validateInput(amb);
  if (!v.ok) fail('歧义样例校验失败：' + v.errors.join(';'));
  const s = solveProblem(v.data);
  if (s.status !== 'optimal') fail('歧义样例应为 optimal');
  if (s.optimalCost !== '0') fail(`歧义样例最优代价应为 0，实际 ${s.optimalCost}`);
  if (s.optimalCount !== '2') fail(`歧义样例最优补全数应为 2，实际 ${s.optimalCount}`);
  const wantStatuses = ['fixed1', 'fixed1', 'variable', 'fixed0'];
  if (JSON.stringify(s.statuses) !== JSON.stringify(wantStatuses)) {
    fail(`问号状态应为 ${wantStatuses}，实际 ${JSON.stringify(s.statuses)}`);
  }
  const canon = s.completion.map((r) => r.join('')).join('');
  if (canon !== '110011001010101000000000') {
    fail(`规范补全矩阵不符：${canon}`);
  }
  // 克隆树：m0 为根（载体6），m1、m2 为其子节点
  const roots = s.tree.roots.map((i) => s.tree.nodes[i]);
  const m0root = roots.find((n) => n.muts.includes('m0'));
  if (!m0root) fail('克隆树根应包含 m0');
  const childMuts = m0root.children.map((i) => s.tree.nodes[i].muts.join(','));
  if (!childMuts.some((x) => x.includes('m1')) || !childMuts.some((x) => x.includes('m2'))) {
    fail(`克隆树 m0 应包含 m1 与 m2 两个子克隆，实际子节点 ${JSON.stringify(childMuts)}`);
  }
  log('  · 计数=2、规范补全=110011001010101000000000、状态 [固定1,固定1,同优可变,固定0] 已核对');
  log('  · 克隆树 m0 ⊃ {m1,m2} 已核对');
}

const conf = {
  cellNames: ['A', 'B', 'C', 'D'],
  mutNames: ['m0', 'm1', 'm2'],
  rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '1', '?'], ['0', '0', '0']],
  costs: [[null, null, null], [null, null, null], [null, null, { c0: '0', c1: '0' }], [null, null, null]],
};
{
  const v = validateInput(conf);
  if (!v.ok) fail('冲突样例校验失败：' + v.errors.join(';'));
  const s = solveProblem(v.data);
  if (s.status !== 'conflict') fail('冲突样例应为 conflict');
  const cf = s.conflicts[0];
  if (!cf || cf.mutA !== 'm0' || cf.mutB !== 'm1' || cf.w11 !== 'A' || cf.w10 !== 'B' || cf.w01 !== 'C') {
    fail(`冲突见证不符：${JSON.stringify(cf)}`);
  }
  log('  · 冲突突变对 m0×m1 与见证 11=A、10=B、01=C 已核对');
}
log('✓ 固定样例核对通过\n');

/* ---------- 4. HTTP 冒烟 ---------- */
log('▶ [4/4] HTTP 冒烟（页面 + /healthz）');
const WEB_URL = process.env.WEB_URL;
let serverProc = null;
let base;
if (WEB_URL) {
  base = WEB_URL.replace(/\/$/, '');
} else {
  const port = process.env.SMOKE_PORT ?? '8099';
  base = `http://127.0.0.1:${port}`;
  serverProc = spawn('node', ['server/main.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
}

try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) { ready = true; break; }
    } catch { /* 服务器尚未起来 */ }
    await sleep(250);
  }
  if (!ready) fail('健康检查 /healthz 未在时限内返回 200');

  const health = await (await fetchJson(`${base}/healthz`)).json();
  if (health.status !== 'ok') fail(`/healthz 内容异常：${JSON.stringify(health)}`);

  const homeRes = await fetchJson(`${base}/`);
  const html = await homeRes.text();
  const okHtml = html.includes('完美谱系')
    && /<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/.test(html)
    && /<link[^>]+href="\/assets\/[^"]+\.css"/.test(html);
  if (!okHtml) {
    fail('首页 HTML 内容异常（缺少标题或构建后的 JS/CSS 资源引用）');
  }
  log(`  · GET /healthz -> 200 {"status":"ok"}`);
  log(`  · GET / -> 200 首页（${html.length} 字节）`);

  // 一个深路径回退到 index.html（SPA）
  const fb = await fetchJson(`${base}/some/spa/route`);
  const fbHtml = await fb.text();
  if (!fbHtml.includes('完美谱系')) fail('SPA 回退异常');
  log('  · SPA 回退 -> index.html 已核对');
} finally {
  if (serverProc) serverProc.kill('SIGTERM');
}
log('✓ HTTP 冒烟通过\n');

log('═══════════════════════════════════════════');
log(' VERIFY 全部通过：测试 / 构建 / 样例核对 / HTTP 冒烟');
log('═══════════════════════════════════════════');
process.exit(0);
