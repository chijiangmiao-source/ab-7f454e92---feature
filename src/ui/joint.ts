// 联合复核界面：与单矩阵流程完全隔离——独立 Worker、独立草稿键、独立结果区。
// 不 import 单矩阵界面的任何状态；单矩阵求解与结果不受本模块影响。
import './styles.css';
import type {
  JointSolveResult,
  JointOptimalResult,
  JointConflictResult,
  JointSideInfeasibleResult,
} from '../solver/joint';
import type { ProblemInput } from '../solver/core';

const JOINT_DRAFT_KEY = 'pp-joint-draft-v1';
const MAX_TOTAL_UNKNOWN = 20;

interface JointDraft { a: string; b: string; enabled: boolean }

function loadDraft(): JointDraft {
  try {
    const raw = localStorage.getItem(JOINT_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as JointDraft;
      if (d && typeof d.a === 'string' && typeof d.b === 'string') return d;
    }
  } catch { /* 损坏草稿忽略 */ }
  return { a: '', b: '', enabled: false };
}

let draft = loadDraft();
let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(JOINT_DRAFT_KEY, JSON.stringify(draft)); } catch { /* 忽略 */ }
  }, 120);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enableChk = $<HTMLInputElement>('joint-enable');
const body = $('joint-body');
const taA = $<HTMLTextAreaElement>('joint-a');
const taB = $<HTMLTextAreaElement>('joint-b');
const solveBtn = $<HTMLButtonElement>('joint-solve');
const statusEl = $<HTMLSpanElement>('joint-status');
const ucountEl = $<HTMLSpanElement>('joint-ucount');
const errorBox = $<HTMLDivElement>('joint-error');
const staleBox = $<HTMLDivElement>('joint-stale');

const elEmpty = $('joint-result-empty');
const elOpt = $('joint-result-optimal');
const elConf = $('joint-result-conflict');
const elSide = $('joint-result-side');

taA.value = draft.a;
taB.value = draft.b;
enableChk.checked = draft.enabled;
body.hidden = !draft.enabled;

enableChk.addEventListener('change', () => {
  draft.enabled = enableChk.checked;
  body.hidden = !draft.enabled;
  persist();
});

for (const [el, key] of [[taA, 'a'], [taB, 'b']] as const) {
  el.addEventListener('input', () => {
    draft[key] = el.value;
    markStale('内容已修改');
    persist();
    updateUnknownCount();
  });
}

/* ----------------------------- 问号计数（尽力解析） ----------------------------- */

function countUnknown(text: string): number | null {
  if (!text.trim()) return 0;
  try {
    const obj = JSON.parse(text) as { rows?: unknown[][] };
    if (!obj || !Array.isArray(obj.rows)) return null;
    let n = 0;
    for (const row of obj.rows) {
      if (!Array.isArray(row)) return null;
      for (const v of row) if (v === '?' || v === null) n++;
    }
    return n;
  } catch { return null; }
}

function updateUnknownCount() {
  const na = countUnknown(taA.value);
  const nb = countUnknown(taB.value);
  if (na === null || nb === null) {
    ucountEl.textContent = '（粘贴后显示问号计数）';
    solveBtn.disabled = busy;
    return;
  }
  const total = na + nb;
  ucountEl.textContent = `问号 矩阵一 ${na} + 矩阵二 ${nb} = ${total}/${MAX_TOTAL_UNKNOWN}`;
  ucountEl.classList.toggle('over', total > MAX_TOTAL_UNKNOWN);
  solveBtn.disabled = busy || total > MAX_TOTAL_UNKNOWN;
}

/* ----------------------------- 独立 Worker（首次求解时懒加载） ----------------------------- */

let worker: Worker | null = null;
let busy = false;

function parsePayload(text: string): { payload?: ProblemInput; error?: string } {
  if (!text.trim()) return { error: '矩阵内容为空。' };
  let obj: unknown;
  try { obj = JSON.parse(text); } catch (e) {
    return { error: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '矩阵必须是 JSON 对象。' };
  return { payload: obj as ProblemInput };
}

solveBtn.addEventListener('click', () => {
  if (busy) return;
  hideError();
  const pa = parsePayload(taA.value);
  const pb = parsePayload(taB.value);
  if (pa.error || pb.error) {
    showErrors([pa.error ? `矩阵一：${pa.error}` : null, pb.error ? `矩阵二：${pb.error}` : null].filter(Boolean) as string[]);
    return;
  }
  busy = true;
  solveBtn.disabled = true;
  statusEl.textContent = 'Worker 联合求解中…';
  statusEl.className = 'status-busy';
  ensureWorker();
  worker!.postMessage({ type: 'solveJoint', payload: { a: pa.payload, b: pb.payload } });
});

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('../solver/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent) => {
    busy = false;
    updateUnknownCount();
    const msg = ev.data as { type?: string; result?: JointSolveResult | { status: 'invalid' | 'error'; errors?: string[] } };
    if (msg?.type !== 'joint-result') return;
    const result = msg.result!;

    if (result.status === 'invalid' || result.status === 'error') {
      statusEl.textContent = '输入有误';
      statusEl.className = 'status-err';
      showErrors(result.errors ?? ['未知错误']);
      // 与单矩阵一致：错误时保留草稿，旧结果以陈旧警示保留
      markStale('当前输入存在格式或规模错误，下方为上一次有效联合复核的结果（如有）');
      return;
    }

    statusEl.textContent = '联合复核完成';
    statusEl.className = 'status-done';
    lastResult = result as JointSolveResult;
    render(result as JointSolveResult);
  };
}

/* ----------------------------- 错误 / 陈旧 ----------------------------- */

function showErrors(errors: string[]) {
  errorBox.hidden = false;
  errorBox.textContent = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
}
function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

let lastResult: JointSolveResult | null = null;
function markStale(reason: string) {
  if (lastResult !== null) {
    staleBox.hidden = false;
    staleBox.textContent = `⚠ ${reason}：以下联合复核结果来自上一次有效求解，不代表当前粘贴内容。`;
  }
}

/* ----------------------------- 结果渲染 ----------------------------- */

function hideAll() {
  elEmpty.hidden = true;
  elOpt.hidden = true;
  elConf.hidden = true;
  elSide.hidden = true;
}

function render(result: JointSolveResult) {
  hideAll();
  staleBox.hidden = true;
  if (result.status === 'joint-optimal') { elOpt.hidden = false; renderOptimal(result); }
  else if (result.status === 'joint-conflict') { elConf.hidden = false; renderConflict(result); }
  else { elSide.hidden = false; renderSide(result); }
}

function renderOptimal(r: JointOptimalResult) {
  $('j-cost').textContent = r.optimalCost;
  $('j-cost-ab').textContent = `${r.optimalCostA}  /  ${r.optimalCostB}`;
  $('j-count').textContent = formatBigCount(r.optimalCount);

  renderSideGrid('j-table-a', r, 'a');
  renderSideGrid('j-table-b', r, 'b');
  renderPairs(r);

  $('j-stats').textContent =
    `联合求解统计：未知格 ${r.stats.unknowns}（一 ${r.stats.unknownsA} · 二 ${r.stats.unknownsB}）` +
    ` · 计数记忆状态 ${r.stats.countNodes} · 联合最优解数为精确任意精度整数`;
}

function renderSideGrid(tableId: string, r: JointOptimalResult, which: 'a' | 'b') {
  const table = $<HTMLTableElement>(tableId);
  const side = r[which];
  const parsed = JSON.parse((which === 'a' ? taA : taB).value) as {
    cellNames?: string[]; mutNames?: string[];
  };
  const cellNames = Array.isArray(parsed.cellNames) ? parsed.cellNames.map(String) : [];
  const mutNames = Array.isArray(parsed.mutNames) ? parsed.mutNames.map(String) : [];
  const R = side.completion.length;
  const C = side.completion[0]?.length ?? 0;

  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (let c = 0; c < C; c++) {
    const th = document.createElement('th');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = mutNames[c] ?? `M${c + 1}`;
    th.appendChild(nm);
    head.appendChild(th);
  }
  table.replaceChildren(head);

  const statusAt = new Map<string, string>();
  side.unknownCells.forEach(({ r: rr, c: cc }, k) => statusAt.set(`${rr},${cc}`, side.statuses[k]));

  for (let i = 0; i < R; i++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('td');
    rh.className = 'row-head';
    rh.textContent = cellNames[i] ?? `${i + 1}`;
    tr.appendChild(rh);
    for (let j = 0; j < C; j++) {
      const td = document.createElement('td');
      const v = side.completion[i][j];
      td.textContent = String(v);
      const st = statusAt.get(`${i},${j}`);
      const isUnknown = st !== undefined;
      td.classList.add(isUnknown ? `cell-${st}` : 'cell-original');
      if (!isUnknown) td.classList.add(v === 0 ? 'cell-fixed0' : 'cell-fixed1');
      if (isUnknown) td.classList.add('ucell');
      td.title = isUnknown
        ? `问号 → ${v}（${st === 'variable' ? '同优可变' : st === 'fixed1' ? '固定 1' : '固定 0'}）`
        : '原始已知值';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
}

const REL_TEXT: Record<string, string> = {
  '=': '=', '<': '<', '>': '>', x: '×', '!': '✕',
};

function renderPairs(r: JointOptimalResult) {
  const tbody = $<HTMLTableElement>('j-pairs').querySelector('tbody')!;
  tbody.replaceChildren();
  for (const p of r.pairs) {
    const tr = document.createElement('tr');
    const cells = [p.mutA, p.mutB, `${REL_TEXT[p.relA]}（${p.labelA}）`, `${REL_TEXT[p.relB]}（${p.labelB}）`];
    for (const t of cells) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.appendChild(td);
    }
    const tdOk = document.createElement('td');
    tdOk.textContent = p.relA === p.relB ? '✓ 一致' : '✗ 不一致';
    tdOk.className = p.relA === p.relB ? 'pair-ok' : 'pair-bad';
    tr.appendChild(tdOk);
    tbody.appendChild(tr);
  }
}

function renderConflict(r: JointConflictResult) {
  const card = $('joint-conflict-card');
  if (!r.conflict) {
    card.textContent = r.message;
    return;
  }
  card.replaceChildren();
  const pair = document.createElement('div');
  pair.className = 'pair';
  pair.textContent = `首个冲突突变对：${r.conflict.mutA} × ${r.conflict.mutB}`;
  const ra = document.createElement('div');
  ra.className = 'witness';
  ra.innerHTML = `<span class="pat">矩阵一</span><span>${r.conflict.labelA}</span>`;
  const rb = document.createElement('div');
  rb.className = 'witness';
  rb.innerHTML = `<span class="pat">矩阵二</span><span>${r.conflict.labelB}</span>`;
  card.append(pair, ra, rb);
}

function renderSide(r: JointSideInfeasibleResult) {
  $('joint-side-msg').textContent = r.message;
}

function formatBigCount(s: string) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ----------------------------- 样例 ----------------------------- */

function payloadText(p: ProblemInput): string {
  return JSON.stringify(p, null, 2);
}

$('joint-sample-ok').addEventListener('click', () => {
  taA.value = payloadText({
    cellNames: ['A', 'B', 'C', 'D', 'E'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['1', '1', '0'],
      ['?', '1', '0'],
      ['1', '0', '1'],
      ['0', '0', '?'],
      ['0', '0', '0'],
    ],
    costs: [
      [null, null, null],
      [{ c0: '5', c1: '0' }, null, null],
      [null, null, null],
      [null, null, { c0: '0', c1: '3' }],
      [null, null, null],
    ],
  });
  taB.value = payloadText({
    cellNames: ['X', 'Y', 'Z', 'W'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['1', '1', '0'],
      ['1', '1', '0'],
      ['0', '0', '1'],
      ['0', '0', '0'],
    ],
    costs: [
      [null, null, null], [null, null, null], [null, null, null], [null, null, null],
    ],
  });
  syncEditors();
});

$('joint-sample-conf').addEventListener('click', () => {
  taA.value = payloadText({
    cellNames: ['A', 'B', 'C', 'D'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['1', '0', '0'],
      ['1', '0', '0'],
      ['0', '1', '0'],
      ['0', '0', '1'],
    ],
    costs: [
      [null, null, null], [null, null, null], [null, null, null], [null, null, null],
    ],
  });
  taB.value = payloadText({
    cellNames: ['X', 'Y', 'Z', 'W', 'V'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['1', '1', '0'],
      ['1', '1', '0'],
      ['1', '0', '0'],
      ['0', '0', '1'],
      ['0', '0', '0'],
    ],
    costs: [
      [null, null, null], [null, null, null], [null, null, null],
      [null, null, null], [null, null, null],
    ],
  });
  syncEditors();
});

$('joint-sample-coupled').addEventListener('click', () => {
  taA.value = payloadText({
    cellNames: ['A', 'B', 'C', 'D'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['?', '1', '0'],
      ['?', '0', '0'],
      ['0', '0', '1'],
      ['0', '0', '0'],
    ],
    costs: [
      [{ c0: '0', c1: '0' }, null, null],
      [{ c0: '0', c1: '0' }, null, null],
      [null, null, null], [null, null, null],
    ],
  });
  taB.value = payloadText({
    cellNames: ['X', 'Y', 'Z', 'W'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [
      ['1', '1', '0'],
      ['0', '0', '0'],
      ['0', '0', '1'],
      ['0', '0', '0'],
    ],
    costs: [
      [null, null, null], [null, null, null], [null, null, null], [null, null, null],
    ],
  });
  syncEditors();
});

$('joint-clear').addEventListener('click', () => {
  taA.value = '';
  taB.value = '';
  syncEditors();
});

// 从单矩阵草稿一键载入到矩阵一（只是复制当前编辑内容，不联动求解）
$('joint-load-draft').addEventListener('click', () => {
  try {
    const raw = localStorage.getItem('pp-completion-draft-v1');
    if (!raw) { alert('上方尚无单矩阵草稿。'); return; }
    const d = JSON.parse(raw) as {
      cellNames: string[]; mutNames: string[];
      grid: string[][]; costs: Array<Array<{ c0: string; c1: string } | null>>;
    };
    const payload: ProblemInput = {
      cellNames: d.cellNames,
      mutNames: d.mutNames,
      rows: d.grid.map((row) => row.slice()) as ProblemInput['rows'],
      costs: d.grid.map((row, r) => row.map((v, c) => (v === '?' ? d.costs[r][c] : null))),
    };
    taA.value = payloadText(payload);
    syncEditors();
  } catch {
    alert('无法读取单矩阵草稿。');
  }
});

function syncEditors() {
  draft.a = taA.value;
  draft.b = taB.value;
  persist();
  updateUnknownCount();
  markStale('已载入样例');
}

/* ----------------------------- 导出 ----------------------------- */

$('joint-export').addEventListener('click', () => {
  if (!lastResult) { alert('还没有联合复核结果。'); return; }
  let inputA: unknown = null;
  let inputB: unknown = null;
  try { inputA = JSON.parse(taA.value); } catch { /* keep null */ }
  try { inputB = JSON.parse(taB.value); } catch { /* keep null */ }
  const blob = new Blob([JSON.stringify({ inputA, inputB, result: lastResult, exportedAt: new Date().toISOString() }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'phylogeny-joint-review.json';
  a.click();
  URL.revokeObjectURL(url);
});

updateUnknownCount();
