// 联合复核 UI：独立于单矩阵录入/求解流程（main.ts）。
// 关闭本面板后，单矩阵求解与结果 DOM 完全不受影响；本模块仅挂载到 #joint-* 节点。
import type { JointSolveResult, JointOptimalResult, JointPairRow, JointConflict } from '../solver/joint';

const JOINT_DRAFT_KEY = 'pp-joint-draft-v1';
const MAX_UNKNOWN_TOTAL = 20;

interface JointDraft { enabled: boolean; a: string; b: string }

function loadDraft(): JointDraft {
  try {
    const raw = localStorage.getItem(JOINT_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as JointDraft;
      if (typeof d.a === 'string' && typeof d.b === 'string') {
        return { enabled: d.enabled !== false, a: d.a, b: d.b };
      }
    }
  } catch { /* 损坏草稿忽略 */ }
  return { enabled: true, a: '', b: '' };
}

let draft = loadDraft();
let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(JOINT_DRAFT_KEY, JSON.stringify(draft)); } catch { /* 存储满等 */ }
  }, 120);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabledEl = $<HTMLInputElement>('joint-enabled');
const bodyEl = $('joint-body');
const taA = $<HTMLTextAreaElement>('joint-a');
const taB = $<HTMLTextAreaElement>('joint-b');
const solveBtn = $<HTMLButtonElement>('joint-solve-btn');
const clearBtn = $<HTMLButtonElement>('joint-clear');
const statusEl = $('joint-status');
const unknownCountEl = $('joint-unknown-count');
const errorBox = $('joint-error-box');
const staleBox = $('joint-stale');
const sampleOkBtn = $('joint-sample-ok');
const sampleConfBtn = $('joint-sample-conf');

const elEmpty = $('joint-result-empty');
const elOpt = $('joint-result-optimal');
const elConf = $('joint-result-conflict');
const elFixed = $('joint-result-fixed');

let jointBusy = false;
let lastJointKey: string | null = null;

const worker = new Worker(new URL('../solver/worker.js', import.meta.url), { type: 'module' });

/* ----------------------------- 草稿 / 计数 ----------------------------- */

taA.value = draft.a;
taB.value = draft.b;
enabledEl.checked = draft.enabled;

function syncEnabled() {
  draft.enabled = enabledEl.checked;
  bodyEl.classList.toggle('joint-disabled', !draft.enabled);
  persist();
}
enabledEl.addEventListener('change', syncEnabled);
syncEnabled();

function bindTextarea(ta: HTMLTextAreaElement, key: 'a' | 'b') {
  ta.addEventListener('input', () => {
    draft[key] = ta.value;
    markStale('草稿已修改');
    updateUnknownCount();
    persist();
  });
}
bindTextarea(taA, 'a');
bindTextarea(taB, 'b');

function parseMatrix(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: '为空' };
  try {
    return { ok: true, data: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: String(e && (e as Error).message ? (e as Error).message : e) };
  }
}

function countUnknowns(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;
  let n = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) return null;
    for (const x of row) if (x === '?' || x === null) n++;
  }
  return n;
}

function updateUnknownCount() {
  const ca = countUnknowns(safeParse(taA.value));
  const cb = countUnknowns(safeParse(taB.value));
  const n = (ca ?? 0) + (cb ?? 0);
  unknownCountEl.textContent = `两份合计问号 ${n}/${MAX_UNKNOWN_TOTAL}`;
  unknownCountEl.classList.toggle('over', n > MAX_UNKNOWN_TOTAL || ca === null || cb === null);
  solveBtn.disabled = jointBusy || !draft.enabled || n > MAX_UNKNOWN_TOTAL;
}
function safeParse(text: string): unknown {
  const p = parseMatrix(text);
  return p.ok ? p.data : null;
}
updateUnknownCount();

clearBtn.addEventListener('click', () => {
  draft.a = '';
  draft.b = '';
  taA.value = '';
  taB.value = '';
  persist();
  updateUnknownCount();
});

/* ----------------------------- 样例 ----------------------------- */

const SAMPLE_OK = {
  a: {
    cellNames: ['A1', 'A2', 'A3', 'A4'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '?', '0'], ['?', '1', '0'], ['0', '0', '1'], ['0', '0', '0']],
    costs: [
      [null, { c0: '0', c1: '3' }, null],
      [{ c0: '0', c1: '2' }, null, null],
      [null, null, null],
      [null, null, null],
    ],
  },
  b: {
    cellNames: ['B1', 'B2', 'B3', 'B4'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['?', '?', '0'], ['0', '0', '?'], ['0', '0', '0']],
    costs: [
      [null, null, null],
      [{ c0: '1', c1: '0' }, { c0: '1', c1: '0' }, null],
      [null, null, { c0: '0', c1: '4' }],
      [null, null, null],
    ],
  },
};

const SAMPLE_CONF = {
  // A：m0 ⊃ m1（11=a0，10=a1）；B：m0 ⊂ m1（11=b0，01=b1）——单份各自层状，联合矛盾
  a: {
    cellNames: ['a0', 'a1', 'a2', 'a3'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  },
  b: {
    cellNames: ['b0', 'b1', 'b2', 'b3'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['0', '1', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  },
};

sampleOkBtn.addEventListener('click', () => loadSample(SAMPLE_OK));
sampleConfBtn.addEventListener('click', () => loadSample(SAMPLE_CONF));
function loadSample(s: { a: unknown; b: unknown }) {
  taA.value = JSON.stringify(s.a, null, 2);
  taB.value = JSON.stringify(s.b, null, 2);
  draft.a = taA.value;
  draft.b = taB.value;
  persist();
  updateUnknownCount();
  markStale('已载入样例');
}

/* ----------------------------- Worker 往返 ----------------------------- */

function showErrors(errors: string[]) {
  errorBox.hidden = false;
  errorBox.textContent = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
}
function hideErrors() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function markStale(reason: string) {
  if (lastJointKey !== null) {
    staleBox.hidden = false;
    staleBox.textContent = `⚠ ${reason}：以下联合复核结果来自上一次有效提交，不代表当前草稿。`;
  }
}

solveBtn.addEventListener('click', () => {
  if (jointBusy || !draft.enabled) return;
  hideErrors();
  const pa = parseMatrix(taA.value);
  const pb = parseMatrix(taB.value);
  if (!pa.ok || !pb.ok) {
    showErrors([
      !pa.ok ? `矩阵 A JSON 无法解析（${pa.error}）` : '',
      !pb.ok ? `矩阵 B JSON 无法解析（${pb.error}）` : '',
    ].filter(Boolean));
    markStale('当前草稿存在格式错误');
    return;
  }
  jointBusy = true;
  updateUnknownCount();
  statusEl.textContent = 'Worker 联合求解中…';
  statusEl.className = 'status-busy';
  worker.postMessage({ type: 'solveJoint', payload: { a: pa.data, b: pb.data } });
});

worker.onmessage = (ev: MessageEvent) => {
  jointBusy = false;
  updateUnknownCount();
  const msg = ev.data as { type?: string; result?: unknown };
  if (msg?.type !== 'jointResult') return;
  const result = msg.result as JointWorkerResult;

  if (isJointFailure(result)) {
    statusEl.textContent = '输入有误';
    statusEl.className = 'status-err';
    showErrors(result.errors ?? ['未知错误']);
    markStale('当前输入存在格式或规模错误'); // 草稿保留，旧结果保留并标陈旧
    return;
  }

  statusEl.textContent = '联合复核完成';
  statusEl.className = 'status-done';
  lastJointKey = JSON.stringify({ a: taA.value, b: taB.value });
  staleBox.hidden = true;
  renderJoint(result);
};

type JointWorkerResult = JointSolveResult | { status: 'invalid' | 'error'; errors?: string[] };
function isJointFailure(r: JointWorkerResult): r is { status: 'invalid' | 'error'; errors?: string[] } {
  return r.status === 'invalid' || r.status === 'error';
}

/* ----------------------------- 结果渲染 ----------------------------- */

function hideAll() {
  elEmpty.hidden = true;
  elOpt.hidden = true;
  elConf.hidden = true;
  elFixed.hidden = true;
}

function renderJoint(result: JointSolveResult) {
  hideAll();
  if (result.status === 'optimal') {
    elOpt.hidden = false;
    renderOptimal(result);
  } else if (result.status === 'joint-conflict') {
    elConf.hidden = false;
    renderConflict(result.conflict);
  } else {
    elFixed.hidden = false;
    renderFixed(result.conflictsA, result.conflictsB);
  }
}

function renderOptimal(r: JointOptimalResult) {
  $('jm-cost').textContent = r.optimalCost;
  $('jm-cost-a').textContent = r.optimalCostA;
  $('jm-cost-b').textContent = r.optimalCostB;
  $('jm-count').textContent = formatBigCount(r.optimalCount);
  renderSideMatrix('joint-table-a', r.a);
  renderSideMatrix('joint-table-b', r.b);
  renderPairs(r.pairs);
  $('joint-stats').textContent =
    `联合统计：A 问号 ${r.stats.unknownsA} · B 问号 ${r.stats.unknownsB} · ` +
    `计数记忆状态 ${r.stats.countNodes} · 最优解数为两份关系一致前提下的精确任意精度整数`;
}

function renderSideMatrix(tableId: string, side: JointOptimalResult['a']) {
  const table = $<HTMLTableElement>(tableId);
  const head = document.createElement('tr');
  const corner = document.createElement('th');
  head.appendChild(corner);
  for (let c = 0; c < side.C; c++) {
    const th = document.createElement('th');
    th.textContent = side.mutNames[c];
    head.appendChild(th);
  }
  table.replaceChildren(head);

  const statusAt = new Map<string, string>();
  side.unknownCells.forEach(({ r, c }, k) => statusAt.set(`${r},${c}`, side.statuses[k]));

  for (let i = 0; i < side.R; i++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('td');
    rh.className = 'row-head';
    rh.textContent = side.cellNames[i];
    tr.appendChild(rh);
    for (let j = 0; j < side.C; j++) {
      const td = document.createElement('td');
      const v = side.completion[i][j];
      td.textContent = String(v);
      const st = statusAt.get(`${i},${j}`);
      const isUnknown = st !== undefined;
      td.classList.add(isUnknown ? `cell-${st}` : 'cell-original');
      if (!isUnknown) td.classList.add(v === 0 ? 'cell-fixed0' : 'cell-fixed1');
      if (isUnknown) td.classList.add('ucell');
      td.title = isUnknown
        ? `问号 → ${v}（${st === 'variable' ? '同优可变' : st === 'fixed1' ? '联合最优中固定 1' : '联合最优中固定 0'}）`
        : '原始已知值';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
}

function witnessText(w: JointPairRow['witnessA']): string {
  const cell = (x: string | null) => x ?? '—';
  return `11 ${cell(w.w11)} ／ 10 ${cell(w.w10)} ／ 01 ${cell(w.w01)}`;
}

function renderPairs(pairs: JointPairRow[]) {
  const table = $<HTMLTableElement>('joint-pairs');
  const head = document.createElement('tr');
  for (const h of ['突变对', '共享关系', 'A 见证细胞', 'B 见证细胞', '一致']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  table.replaceChildren(head);
  for (const p of pairs) {
    const tr = document.createElement('tr');
    const tdPair = document.createElement('td');
    tdPair.className = 'pair-names';
    tdPair.textContent = `${p.mutA} × ${p.mutB}`;
    const tdRel = document.createElement('td');
    tdRel.innerHTML = `<span class="rel-sym">${p.relSymbol}</span> ${p.relLabel}`;
    const tdA = document.createElement('td');
    tdA.className = 'mono';
    tdA.textContent = witnessText(p.witnessA);
    const tdB = document.createElement('td');
    tdB.className = 'mono';
    tdB.textContent = witnessText(p.witnessB);
    const tdOk = document.createElement('td');
    tdOk.textContent = p.consistent ? '✓' : '✗';
    tdOk.className = p.consistent ? 'rel-ok' : 'rel-bad';
    tr.append(tdPair, tdRel, tdA, tdB, tdOk);
    table.appendChild(tr);
  }
}

function renderConflict(c: JointConflict) {
  $('joint-conflict-msg').textContent = c.message;
  const list = $('joint-conflict-list');
  list.replaceChildren();
  for (const w of c.witnesses) {
    const card = document.createElement('div');
    card.className = 'conflict-card';
    const cell = (x: string | null) => x ?? '—';
    card.innerHTML =
      `<div class="pair">矩阵 ${w.side}：${w.mutX} 与 ${w.mutY}（该份所需关系：${w.rel}）</div>` +
      `<div class="witness"><span class="pat">11</span><span>细胞「${cell(w.cells.w11)}」</span></div>` +
      `<div class="witness"><span class="pat">10</span><span>细胞「${cell(w.cells.w10)}」</span></div>` +
      `<div class="witness"><span class="pat">01</span><span>细胞「${cell(w.cells.w01)}」</span></div>`;
    list.appendChild(card);
  }
}

interface FixedConflictLike {
  mutA: string; mutB: string; w11: string; w10: string; w01: string;
}
function renderFixed(ca: FixedConflictLike[], cb: FixedConflictLike[]) {
  const list = $('joint-fixed-list');
  list.replaceChildren();
  const pushSide = (tag: string, conflicts: FixedConflictLike[]) => {
    for (const cf of conflicts) {
      const card = document.createElement('div');
      card.className = 'conflict-card';
      card.innerHTML =
        `<div class="pair">矩阵 ${tag}：${cf.mutA} × ${cf.mutB}</div>` +
        `<div class="witness"><span class="pat">11</span><span>细胞「${cf.w11}」</span></div>` +
        `<div class="witness"><span class="pat">10</span><span>细胞「${cf.w10}」</span></div>` +
        `<div class="witness"><span class="pat">01</span><span>细胞「${cf.w01}」</span></div>`;
      list.appendChild(card);
    }
  };
  pushSide('A', ca);
  pushSide('B', cb);
}

function formatBigCount(s: string) {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped;
}
