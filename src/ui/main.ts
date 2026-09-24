import './styles.css';
import type { SolveResult, OptimalResult, FixedConflict } from '../solver/core';

/* ----------------------------- 草稿模型 ----------------------------- */

interface CostPair { c0: string; c1: string }
interface Draft {
  R: number;
  C: number;
  cellNames: string[];
  mutNames: string[];
  grid: string[][]; // '0' | '1' | '?'
  costs: (CostPair | null)[][];
}

const DRAFT_KEY = 'pp-completion-draft-v1';
const MAX_R = 18;
const MIN_R = 4;
const MAX_C = 12;
const MIN_C = 3;
const MAX_UNKNOWN = 28;

function emptyDraft(R: number, C: number): Draft {
  return {
    R,
    C,
    cellNames: Array.from({ length: R }, (_, i) => `细胞${i + 1}`),
    mutNames: Array.from({ length: C }, (_, j) => `M${j + 1}`),
    grid: Array.from({ length: R }, () => Array<string>(C).fill('0')),
    costs: Array.from({ length: R }, () => Array<CostPair | null>(C).fill(null)),
  };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d && Array.isArray(d.grid) && d.R >= MIN_R && d.C >= MIN_C) return d;
    }
  } catch { /* 忽略损坏草稿 */ }
  return emptyDraft(6, 5);
}

let draft = loadDraft();
let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* 存储满等 */ }
  }, 120);
}

/* ----------------------------- DOM 引用 ----------------------------- */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inputTable = $<HTMLTableElement>('input-table');
const resultTable = $<HTMLTableElement>('result-table');
const errorBox = $<HTMLDivElement>('error-box');
const workerStatus = $<HTMLSpanElement>('worker-status');
const solveBtn = $<HTMLButtonElement>('solve-btn');
const unknownCountEl = $<HTMLSpanElement>('unknown-count');

function updateUnknownCount() {
  let n = 0;
  for (const row of draft.grid) for (const v of row) if (v === '?') n++;
  unknownCountEl.textContent = `问号 ${n}/${MAX_UNKNOWN}`;
  unknownCountEl.classList.toggle('over', n > MAX_UNKNOWN);
  solveBtn.disabled = busy || n > MAX_UNKNOWN;
}

/* ----------------------------- 输入表渲染 ----------------------------- */

function ensureSize(R: number, C: number) {
  draft.cellNames = Array.from({ length: R }, (_, i) => draft.cellNames[i] ?? `细胞${i + 1}`);
  draft.mutNames = Array.from({ length: C }, (_, j) => draft.mutNames[j] ?? `M${j + 1}`);
  draft.grid = Array.from({ length: R }, (_, r) =>
    Array.from({ length: C }, (_, c) => draft.grid[r]?.[c] ?? '0'),
  );
  draft.costs = Array.from({ length: R }, (_, r) =>
    Array.from({ length: C }, (_, c) => draft.costs?.[r]?.[c] ?? null),
  );
  draft.R = R;
  draft.C = C;
}

function renderInputTable() {
  const { R, C } = draft;
  const head = document.createElement('tr');
  const corner = document.createElement('th');
  corner.textContent = '';
  head.appendChild(corner);
  for (let c = 0; c < C; c++) {
    const th = document.createElement('th');
    const nm = document.createElement('input');
    nm.className = 'mut-name';
    nm.value = draft.mutNames[c];
    nm.addEventListener('input', () => { draft.mutNames[c] = nm.value; markStale('名称已修改'); persist(); });
    th.appendChild(nm);
    const hdr = document.createElement('span');
    hdr.className = 'costhdr';
    hdr.textContent = '? 的代价 c0/c1';
    th.appendChild(hdr);
    head.appendChild(th);
  }
  inputTable.replaceChildren(head);

  for (let r = 0; r < R; r++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('td');
    rh.className = 'row-head';
    const nm = document.createElement('input');
    nm.className = 'row-name';
    nm.value = draft.cellNames[r];
    nm.addEventListener('input', () => { draft.cellNames[r] = nm.value; markStale('名称已修改'); persist(); });
    rh.appendChild(nm);
    tr.appendChild(rh);

    for (let c = 0; c < C; c++) {
      const td = document.createElement('td');
      if (draft.grid[r][c] === '?') {
        const wrap = document.createElement('div');
        wrap.className = 'costpair';
        const cellBtn = document.createElement('button');
        cellBtn.type = 'button';
        cellBtn.className = 'cell-btn vq';
        cellBtn.textContent = '?';
        cellBtn.title = '点击切换 0 / 1 / ?';
        cellBtn.addEventListener('click', () => cycleCell(r, c));
        const cp = draft.costs[r][c] ?? { c0: '0', c1: '0' };
        draft.costs[r][c] = cp;
        const i0 = document.createElement('input');
        i0.type = 'text';
        i0.inputMode = 'numeric';
        i0.className = 'c0';
        i0.value = cp.c0;
        i0.placeholder = 'c0';
        i0.title = '填 0 的代价';
        i0.addEventListener('input', () => { cp.c0 = i0.value.trim(); markStale('代价已修改'); persist(); });
        const i1 = document.createElement('input');
        i1.type = 'text';
        i1.inputMode = 'numeric';
        i1.className = 'c1';
        i1.value = cp.c1;
        i1.placeholder = 'c1';
        i1.title = '填 1 的代价';
        i1.addEventListener('input', () => { cp.c1 = i1.value.trim(); markStale('代价已修改'); persist(); });
        wrap.append(cellBtn, i0, i1);
        td.appendChild(wrap);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        const v = draft.grid[r][c];
        btn.className = 'cell-btn ' + (v === '0' ? 'v0' : 'v1');
        btn.textContent = v;
        btn.title = '点击切换 0 / 1 / ?';
        btn.addEventListener('click', () => cycleCell(r, c));
        td.appendChild(btn);
      }
      tr.appendChild(td);
    }
    inputTable.appendChild(tr);
  }
  updateUnknownCount();
}

function cycleCell(r: number, c: number) {
  const cur = draft.grid[r][c];
  const nxt = cur === '0' ? '1' : cur === '1' ? '?' : '0';
  draft.grid[r][c] = nxt;
  if (nxt === '?' && !draft.costs[r][c]) draft.costs[r][c] = { c0: '0', c1: '0' };
  if (nxt !== '?') draft.costs[r][c] = null;
  markStale('矩阵已修改');
  persist();
  renderInputTable();
  updateUnknownCount();
}

/* ----------------------------- 尺寸与样例 ----------------------------- */

$('apply-dims').addEventListener('click', () => {
  const R = clampInt($<HTMLInputElement>('dim-r').value, MIN_R, MAX_R);
  const C = clampInt($<HTMLInputElement>('dim-c').value, MIN_C, MAX_C);
  ensureSize(R, C);
  markStale('尺寸已修改');
  persist();
  renderInputTable();
});

function clampInt(v: string, lo: number, hi: number) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function loadSample(d: Draft) {
  draft = d;
  ($<HTMLInputElement>('dim-r')).value = String(d.R);
  ($<HTMLInputElement>('dim-c')).value = String(d.C);
  persist();
  renderInputTable();
  markStale('已载入样例');
}

function mkDraft(
  cellNames: string[],
  mutNames: string[],
  rows: string[][],
  costAt: Record<string, [string, string]>,
): Draft {
  const R = cellNames.length;
  const C = mutNames.length;
  const d = emptyDraft(R, C);
  d.cellNames = cellNames.slice();
  d.mutNames = mutNames.slice();
  d.grid = rows.map((row) => row.slice());
  for (const [key, [c0, c1]] of Object.entries(costAt)) {
    const [r, c] = key.split(',').map(Number);
    d.costs[r][c] = { c0, c1 };
  }
  return d;
}

$('sample-amb').addEventListener('click', () => {
  // m0 必须包含 m1={A,B} 与 m2={C,D} 两个不交集合 ⇒ B、D 的问号在最优下固定 1；
  // m3 在 E 的问号取 0/1 同代价 ⇒ 同优可变；F 行 m0 取 1 仍可行但更贵 ⇒ 固定 0。
  loadSample(mkDraft(
    ['A', 'B', 'C', 'D', 'E', 'F'],
    ['m0', 'm1', 'm2', 'm3'],
    [
      ['1', '1', '0', '0'],
      ['?', '1', '0', '0'],
      ['1', '0', '1', '0'],
      ['?', '0', '1', '0'],
      ['0', '0', '0', '?'],
      ['?', '0', '0', '0'],
    ],
    { '1,0': ['9', '0'], '3,0': ['9', '0'], '4,3': ['0', '0'], '5,0': ['0', '5'] },
  ));
});

$('sample-conf').addEventListener('click', () => {
  // m0 与 m1 的固定值已同时具备 11(A)、10(B)、01(C) 三个见证
  loadSample(mkDraft(
    ['A', 'B', 'C', 'D'],
    ['m0', 'm1', 'm2'],
    [
      ['1', '1', '0'],
      ['1', '0', '0'],
      ['0', '1', '?'],
      ['0', '0', '0'],
    ],
    { '2,2': ['0', '0'] },
  ));
});

$('sample-chain').addEventListener('click', () => {
  // 嵌套链 m3 ⊂ m2 ⊂ m1 ⊂ m0；末行全问号
  loadSample(mkDraft(
    ['A', 'B', 'C', 'D', 'E', 'F'],
    ['m0', 'm1', 'm2', 'm3'],
    [
      ['1', '1', '1', '1'],
      ['1', '1', '1', '0'],
      ['1', '1', '0', '0'],
      ['1', '0', '0', '0'],
      ['0', '0', '0', '0'],
      ['?', '?', '?', '?'],
    ],
    { '5,0': ['0', '3'], '5,1': ['1', '0'], '5,2': ['1', '0'], '5,3': ['1', '0'] },
  ));
});

$('clear-all').addEventListener('click', () => {
  const d = emptyDraft(draft.R, draft.C);
  loadSample(d);
});

/* ----------------------------- Worker ----------------------------- */

const worker = new Worker(new URL('../solver/worker.js', import.meta.url), { type: 'module' });
let busy = false;

function buildPayload() {
  return {
    cellNames: draft.cellNames,
    mutNames: draft.mutNames,
    rows: draft.grid.map((row) => row.slice()),
    costs: draft.grid.map((row, r) =>
      row.map((v, c) => (v === '?' ? draft.costs[r][c] : null)),
    ),
  };
}

solveBtn.addEventListener('click', () => {
  if (busy) return;
  hideError();
  const payload = buildPayload();
  busy = true;
  updateUnknownCount();
  workerStatus.textContent = 'Worker 求解中…';
  workerStatus.className = 'status-busy';
  worker.postMessage({ type: 'solve', payload });
});

worker.onmessage = (ev: MessageEvent) => {
  busy = false;
  updateUnknownCount();
  const msg = ev.data as { type: string; result?: unknown };
  if (msg?.type !== 'result') return;
  const result = msg.result as (SolveResult | { status: 'invalid' | 'error'; errors?: string[] });

  if (result.status === 'invalid' || result.status === 'error') {
    // 关键：格式/规模错误时保留草稿与旧结果，绝不拿旧结果冒充本次结论
    workerStatus.textContent = '输入有误';
    workerStatus.className = 'status-err';
    showErrors(result.errors ?? ['未知错误']);
    markStale('当前输入存在格式或规模错误，下方为上一次有效输入的结果（如有）');
    return;
  }

  workerStatus.textContent = '求解完成';
  workerStatus.className = 'status-done';
  lastPayloadKey = JSON.stringify(buildPayload());
  lastResult = result as SolveResult;
  renderResult(result as SolveResult);
};

/* ----------------------------- 错误与陈旧标记 ----------------------------- */

function showErrors(errors: string[]) {
  errorBox.hidden = false;
  errorBox.textContent = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
}
function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

let lastPayloadKey: string | null = null;
let lastResult: SolveResult | null = null;
const staleBox = $<HTMLDivElement>('result-stale');
function markStale(reason: string) {
  if (lastPayloadKey !== null) {
    staleBox.hidden = false;
    staleBox.textContent = `⚠ ${reason}：以下结果来自上一次有效求解，不代表当前草稿。`;
  }
}

/* ----------------------------- 结果渲染 ----------------------------- */

const elEmpty = $<HTMLDivElement>('result-empty');
const elOpt = $<HTMLDivElement>('result-optimal');
const elConf = $<HTMLDivElement>('result-conflict');
const elInfeas = $<HTMLDivElement>('result-infeasible');

function hideAllResults() {
  elEmpty.hidden = true;
  elOpt.hidden = true;
  elConf.hidden = true;
  elInfeas.hidden = true;
}

function renderResult(result: SolveResult) {
  hideAllResults();
  staleBox.hidden = true;
  if (result.status === 'optimal') {
    elOpt.hidden = false;
    renderOptimal(result);
  } else if (result.status === 'conflict') {
    elConf.hidden = false;
    renderConflicts(result.conflicts);
  } else {
    elInfeas.hidden = false;
    renderInfeasible(result.diagnostics);
  }
}

function renderOptimal(r: OptimalResult) {
  $<HTMLDivElement>('m-cost').textContent = r.optimalCost;
  $<HTMLDivElement>('m-count').textContent = formatBigCount(r.optimalCount);

  // 规范矩阵
  const head = document.createElement('tr');
  const corner = document.createElement('th');
  corner.textContent = '';
  head.appendChild(corner);
  for (let c = 0; c < draft.C; c++) {
    const th = document.createElement('th');
    th.innerHTML = `<span class="nm"></span>`;
    th.querySelector('.nm')!.textContent = draft.mutNames[c];
    head.appendChild(th);
  }
  resultTable.replaceChildren(head);

  const statusAt = new Map<string, string>();
  r.unknownCells.forEach(({ r: rr, c: cc }, k) => statusAt.set(`${rr},${cc}`, r.statuses[k]));

  for (let i = 0; i < draft.R; i++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('td');
    rh.className = 'row-head';
    rh.textContent = draft.cellNames[i];
    tr.appendChild(rh);
    for (let j = 0; j < draft.C; j++) {
      const td = document.createElement('td');
      const v = r.completion[i][j];
      td.textContent = String(v);
      const key = `${i},${j}`;
      const st = statusAt.get(key);
      const isUnknown = st !== undefined;
      td.classList.add(isUnknown ? `cell-${st}` : 'cell-original');
      if (!isUnknown) td.classList.add(v === 0 ? 'cell-fixed0' : 'cell-fixed1');
      if (isUnknown) td.classList.add('ucell');
      td.title = isUnknown
        ? `问号 → ${v}（${st === 'variable' ? '同优可变' : st === 'fixed1' ? '固定 1' : '固定 0'}）`
        : '原始已知值';
      tr.appendChild(td);
    }
    resultTable.appendChild(tr);
  }

  renderTree(r);

  $<HTMLDivElement>('stats-line').textContent =
    `求解统计：未知格 ${r.stats.unknowns} · 计数记忆状态 ${r.stats.countNodes} · 最优补全数为精确任意精度整数`;
}

function formatBigCount(s: string) {
  // 完整数字 + 千分位分组，绝不截断
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped;
}

function renderTree(r: OptimalResult) {
  const box = $<HTMLDivElement>('tree-box');
  box.replaceChildren();
  const { nodes, roots } = r.tree;

  const renderNode = (idx: number): HTMLElement => {
    const node = nodes[idx];
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'tree-node' + (node.parent < 0 ? ' tree-root' : '');
    const muts = document.createElement('span');
    muts.className = 'muts';
    muts.textContent = node.muts.join('、');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `载体 ${node.carrierCount}`;
    const cells = document.createElement('span');
    cells.className = 'cells';
    cells.textContent = node.cells.length ? `细胞：${node.cells.join('、')}` : '';
    chip.append(muts, meta, cells);
    li.appendChild(chip);
    if (node.children.length) {
      const ul = document.createElement('ul');
      ul.className = 'tree';
      for (const ch of node.children) ul.appendChild(renderNode(ch));
      li.appendChild(ul);
    }
    return li;
  };

  const rootUl = document.createElement('ul');
  rootUl.className = 'tree';
  rootUl.style.borderLeft = 'none';
  rootUl.style.paddingLeft = '0';
  for (const idx of roots) rootUl.appendChild(renderNode(idx));
  box.appendChild(rootUl);

  const em = $<HTMLDivElement>('empty-muts');
  const parts: string[] = [];
  if (r.tree.emptyMuts.length) {
    parts.push(`无载体突变（恒为 0，未进入克隆树）：${r.tree.emptyMuts.join('、')}`);
  }
  const rootless: string[] = [];
  for (let i = 0; i < draft.R; i++) {
    if (r.completion[i].every((v) => v === 0)) rootless.push(draft.cellNames[i]);
  }
  if (rootless.length) parts.push(`未携带任何突变的细胞（挂在虚拟根）：${rootless.join('、')}`);
  if (parts.length) {
    em.hidden = false;
    em.textContent = parts.join('　|　');
  } else {
    em.hidden = true;
    em.textContent = '';
  }
}

function patWitnessHtml(pat: string, w: { cell: string; values: Record<string, { value: number; forced: boolean }> }) {
  const items = Object.entries(w.values).map(([mut, info]) => {
    const tag = info.forced ? '<span class="forced-note">（问号被迫）</span>' : '';
    return `<span class="mono">${mut}=${info.value}</span>${tag}`;
  });
  return `<div class="witness"><span class="pat">${pat}</span><span>细胞「${w.cell}」：</span>${items.join('，')}</div>`;
}

function renderConflicts(conflicts: FixedConflict[]) {
  const list = $<HTMLDivElement>('conflict-list');
  list.replaceChildren();
  for (const cf of conflicts) {
    const card = document.createElement('div');
    card.className = 'conflict-card';
    card.innerHTML =
      `<div class="pair">突变对：${cf.mutA} × ${cf.mutB}</div>` +
      `<div class="witness"><span class="pat">11</span><span>细胞「${cf.w11}」</span></div>` +
      `<div class="witness"><span class="pat">10</span><span>细胞「${cf.w10}」</span></div>` +
      `<div class="witness"><span class="pat">01</span><span>细胞「${cf.w01}」</span></div>`;
    list.appendChild(card);
  }
}

interface InfeasDiag {
  kind?: string;
  failedMut?: string;
  message?: string;
  witnesses?: Array<{
    mutA: string; mutB: string;
    w11: { cell: string; values: Record<string, { value: number; forced: boolean }> } | null;
    w10: { cell: string; values: Record<string, { value: number; forced: boolean }> } | null;
    w01: { cell: string; values: Record<string, { value: number; forced: boolean }> } | null;
  }>;
}

function renderInfeasible(diag: unknown) {
  const box = $<HTMLDivElement>('infeasible-detail');
  box.replaceChildren();
  const d = (diag ?? {}) as InfeasDiag;
  if (d.message) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = d.message;
    box.appendChild(p);
  }
  for (const w of d.witnesses ?? []) {
    const card = document.createElement('div');
    card.className = 'conflict-card';
    let html = `<div class="pair">与「${w.mutA}」相关的配型见证（对照突变 ${w.mutB}）</div>`;
    if (w.w11) html += patWitnessHtml('11', w.w11);
    if (w.w10) html += patWitnessHtml('10', w.w10);
    if (w.w01) html += patWitnessHtml('01', w.w01);
    card.innerHTML = html;
    box.appendChild(card);
  }
}

/* ----------------------------- 导出 ----------------------------- */

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

$('export-input').addEventListener('click', () => {
  download('phylogeny-input.json', JSON.stringify(buildPayload(), null, 2));
});
$('export-result').addEventListener('click', () => {
  if (lastResult === null) { alert('还没有成功的求解结果。'); return; }
  const snapshot = {
    input: buildPayload(),
    result: lastResult,
    exportedAt: new Date().toISOString(),
  };
  download('phylogeny-result.json', JSON.stringify(snapshot, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
});

/* ----------------------------- 初始化 ----------------------------- */

($<HTMLInputElement>('dim-r')).value = String(draft.R);
($<HTMLInputElement>('dim-c')).value = String(draft.C);
renderInputTable();
updateUnknownCount();
