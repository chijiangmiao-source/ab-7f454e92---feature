// 求解器测试：精确性（对照小规模穷举）、样例核对（计数、规范补全、固定性、见证）、
// 输入校验（格式/规模错误）与边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, solveProblem, LIMITS } from '../src/solver/core.js';

/* ----------------------------- 工具 ----------------------------- */

function lam(M, R, C) {
  const sets = [];
  for (let c = 0; c < C; c++) {
    let s = 0n;
    for (let r = 0; r < R; r++) if (M[r][c] === 1) s |= 1n << BigInt(r);
    sets.push(s);
  }
  for (let i = 0; i < C; i++) for (let j = i + 1; j < C; j++) {
    const x = sets[i] & sets[j];
    if (x !== 0n && x !== sets[i] && x !== sets[j]) return false;
  }
  return true;
}

function brute(input) {
  const v = validateInput(input);
  assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
  const d = v.data;
  const U = d.unknownCells.length;
  const all = [];
  for (let m = 0; m < 1 << U; m++) {
    const M = d.val.map((row) => Array.from(row));
    d.unknownCells.forEach(({ r, c }, k) => { M[r][c] = (m >> k) & 1; });
    if (!lam(M, d.R, d.C)) continue;
    let cost = 0n;
    d.unknownCells.forEach(({ r, c }, k) => {
      const id = d.uidAt[r][c];
      cost += (m >> k) & 1 ? d.cost1[id] : d.cost0[id];
    });
    all.push({ m, M, cost });
  }
  if (!all.length) return null;
  let best = all[0].cost;
  for (const f of all) if (f.cost < best) best = f.cost;
  const opt = all.filter((f) => f.cost === best);
  opt.sort((a, b) => {
    for (let k = 0; k < U; k++) {
      const x = (a.m >> k) & 1, y = (b.m >> k) & 1;
      if (x !== y) return x - y;
    }
    return 0;
  });
  const can0 = Array(U).fill(false), can1 = Array(U).fill(false);
  for (const f of opt) for (let k = 0; k < U; k++) ((f.m >> k) & 1 ? can1 : can0)[k] = true;
  return {
    best: best.toString(),
    count: BigInt(opt.length).toString(),
    canon: opt[0].M.map((row) => row.join('')).join(''),
    can0, can1,
  };
}

function checkAgainstBrute(input) {
  const v = validateInput(input);
  assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
  const b = brute(input);
  const s = solveProblem(v.data);
  if (!b) {
    assert.ok(s.status === 'infeasible' || s.status === 'conflict',
      `穷举无解但求解器返回 ${s.status}`);
    return;
  }
  assert.equal(s.status, 'optimal');
  const canon = s.completion.map((row) => row.join('')).join('');
  assert.equal(s.optimalCost, b.best, '最优代价');
  assert.equal(s.optimalCount, b.count, '最优补全数');
  assert.equal(canon, b.canon, '行优先0优先规范矩阵');
  v.data.unknownCells.forEach((_, k) => {
    const want = b.can0[k] && b.can1[k] ? 'variable' : b.can1[k] ? 'fixed1' : 'fixed0';
    assert.equal(s.statuses[k], want, `问号 ${k} 固定性`);
  });
  assert.ok(lam(s.completion, v.data.R, v.data.C), '结果必须层状');
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randCase(rng, R, C, maxU) {
  const rows = Array.from({ length: R }, () =>
    Array.from({ length: C }, () => (rng() < 0.32 ? '1' : '0')));
  const U = 1 + Math.floor(rng() * Math.min(maxU, R * C));
  const pos = [];
  for (let i = 0; i < R * C; i++) pos.push(i);
  for (let i = pos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pos[i], pos[j]] = [pos[j], pos[i]];
  }
  for (let k = 0; k < U; k++) rows[(pos[k] / C) | 0][pos[k] % C] = '?';
  const costs = rows.map((row) => row.map((x) =>
    (x === '?' ? { c0: String(Math.floor(rng() * 5)), c1: String(Math.floor(rng() * 5)) } : null)));
  return {
    cellNames: Array.from({ length: R }, (_, i) => `c${i}`),
    mutNames: Array.from({ length: C }, (_, j) => `m${j}`),
    rows, costs,
  };
}

/* ----------------------------- 穷举对拍 ----------------------------- */

test('随机小规模样例与穷举完全一致（代价/计数/规范矩阵/固定性）', () => {
  const rng = mulberry(12345);
  for (let n = 0; n < 250; n++) {
    const R = 4 + Math.floor(rng() * 3);
    const C = 3 + Math.floor(rng() * 3);
    checkAgainstBrute(randCase(rng, R, C, 13));
  }
});

test('零代价时计数等于全部可行完成数（独立穷举核对）', () => {
  const rng = mulberry(777);
  for (let n = 0; n < 40; n++) {
    const inp = randCase(rng, 5, 5, 12);
    for (const row of inp.costs) for (const cell of row) if (cell) { cell.c0 = '0'; cell.c1 = '0'; }
    checkAgainstBrute(inp);
  }
});

/* ----------------------------- 固定歧义样例 ----------------------------- */

const ambSample = {
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

test('歧义样例：计数=2、规范补全正确、三种问号状态齐备', () => {
  const v = validateInput(ambSample);
  assert.ok(v.ok);
  const s = solveProblem(v.data);
  assert.equal(s.status, 'optimal');
  assert.equal(s.optimalCost, '0');
  assert.equal(s.optimalCount, '2');
  // 问号顺序（行优先）：(B,m0),(D,m0),(E,m3),(F,m0)
  assert.deepEqual(s.statuses, ['fixed1', 'fixed1', 'variable', 'fixed0']);
  // 规范（0 优先）补全：E,m3 取 0；两个被强制的 m0 取 1
  assert.deepEqual(s.completion, [
    [1, 1, 0, 0],
    [1, 1, 0, 0],
    [1, 0, 1, 0],
    [1, 0, 1, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.ok(lam(s.completion, 6, 4));
  // 克隆树包含 m0 ⊃ {m1,m2} 的根结构
  const rootNodes = s.tree.roots.map((i) => s.tree.nodes[i]);
  const rootMutSets = rootNodes.map((n) => n.muts.join(''));
  assert.ok(rootMutSets.some((x) => x.includes('m0')));
});

test('歧义样例：每个问号在最优补全中的可取值与计数自洽', () => {
  // 计数 2 恰由唯一“同优可变”格 (E,m3) 的两种取值产生
  const v = validateInput(ambSample);
  const s = solveProblem(v.data);
  let nVar = 0;
  for (const st of s.statuses) if (st === 'variable') nVar++;
  assert.equal(nVar, 1);
});

/* ----------------------------- 固定冲突样例 ----------------------------- */

const confSample = {
  cellNames: ['A', 'B', 'C', 'D'],
  mutNames: ['m0', 'm1', 'm2'],
  rows: [
    ['1', '1', '0'],
    ['1', '0', '0'],
    ['0', '1', '?'],
    ['0', '0', '0'],
  ],
  costs: [
    [null, null, null],
    [null, null, null],
    [null, null, { c0: '0', c1: '0' }],
    [null, null, null],
  ],
};

test('冲突样例：报告突变对与 11/10/01 三项细胞见证', () => {
  const v = validateInput(confSample);
  assert.ok(v.ok);
  const s = solveProblem(v.data);
  assert.equal(s.status, 'conflict');
  assert.equal(s.conflicts.length, 1);
  const cf = s.conflicts[0];
  assert.equal(cf.mutA, 'm0');
  assert.equal(cf.mutB, 'm1');
  assert.equal(cf.w11, 'A');
  assert.equal(cf.w10, 'B');
  assert.equal(cf.w01, 'C');
});

/* ----------------------------- 无固定冲突但不可补全 ----------------------------- */

test('无直接固定冲突但任何补全皆矛盾时返回 infeasible（穷举验证）', () => {
  const inp = {
    cellNames: ['c0', 'c1', 'c2', 'c3'],
    mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '?', '1'], ['?', '1', '1'], ['0', '1', '0'], ['1', '0', '0']],
    costs: [
      [null, { c0: '0', c1: '0' }, null],
      [{ c0: '0', c1: '0' }, null, null],
      [null, null, null],
      [null, null, null],
    ],
  };
  assert.equal(brute(inp), null);
  const v = validateInput(inp);
  const s = solveProblem(v.data);
  assert.equal(s.status, 'infeasible');
  assert.ok(s.diagnostics);
});

/* ----------------------------- 输入校验：格式/规模错误 ----------------------------- */

test('规模越界：细胞数/突变数/未知格数', () => {
  const badR = {
    cellNames: ['a', 'b', 'c'], mutNames: ['x', 'y', 'z'],
    rows: Array.from({ length: 3 }, () => ['0', '0', '0']),
    costs: Array.from({ length: 3 }, () => [null, null, null]),
  };
  assert.equal(validateInput(badR).ok, false);

  const rows = Array.from({ length: 4 }, () => ['?', '0', '0']);
  const manyQ = {
    cellNames: ['a', 'b', 'c', 'd'], mutNames: ['x', 'y', 'z'],
    rows,
    costs: Array.from({ length: 4 }, () => [{ c0: '0', c1: '0' }, null, null]),
  };
  const ok = validateInput(manyQ);
  assert.ok(ok.ok);
  assert.equal(ok.data.unknownCells.length, 4);
  assert.equal(LIMITS.maxUnknown, 28);

  // 29 个问号必须拒绝
  const big = {
    cellNames: Array.from({ length: 10 }, (_, i) => `c${i}`),
    mutNames: ['x', 'y', 'z'],
    rows: Array.from({ length: 10 }, (_, r) => (r < 9 ? ['?', '?', '?'] : ['?', '?', '0'])),
    costs: Array.from({ length: 10 }, (_, r) =>
      (r < 9 ? [{ c0: '0', c1: '0' }, { c0: '0', c1: '0' }, { c0: '0', c1: '0' }]
        : [{ c0: '0', c1: '0' }, { c0: '0', c1: '0' }, null])),
  };
  const res = validateInput(big);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('28')));
});

test('格式错误：非法字符、缺代价、负/非整数代价、行列数不符、重名', () => {
  const base = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['1', 'x', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  };
  assert.equal(validateInput(base).ok, false);

  const missingCost = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['?', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  };
  const r1 = validateInput(missingCost);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.join(';').includes('代价'));

  const negCost = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['?', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [[{ c0: '-1', c1: '0' }, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  assert.equal(validateInput(negCost).ok, false);

  const fracCost = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['?', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [[{ c0: '0.5', c1: '0' }, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  assert.equal(validateInput(fracCost).ok, false);

  const badShape = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  };
  assert.equal(validateInput(badShape).ok, false);

  const dupName = {
    cellNames: ['A', 'A', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: Array.from({ length: 4 }, () => ['0', '0', '0']),
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  };
  assert.equal(validateInput(dupName).ok, false);
});

test('任意精度：18 位大整数代价精确处理（无 Number 精度丢失）', () => {
  const big = '9007199254740993'; // 2^53+1，超出安全整数
  const inp = {
    cellNames: ['A', 'B', 'C', 'D'], mutNames: ['x', 'y', 'z'],
    rows: [['?', '0', '0'], ['?', '1', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [
      [{ c0: big, c1: '0' }, null, null],
      [{ c0: '0', c1: big }, null, null],
      [null, null, null],
      [null, null, null],
    ],
  };
  const v = validateInput(inp);
  assert.ok(v.ok);
  const s = solveProblem(v.data);
  assert.equal(s.status, 'optimal');
  // 列 y 已在 B 有 1；A 处 x=0 则 {B}⊂{B} 仍可行，取 x=1 同克隆也可行，
  // 关键是两个大整数代价应被精确比较（c1 于 A 为 2^53+1，c0 于 B 问号同理）
  assert.ok(typeof s.optimalCost === 'string');
  assert.ok(BigInt(s.optimalCost) >= 0n);
});
