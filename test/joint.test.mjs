// 联合复核求解器测试：
//  - 随机小规模样例与“两份补全两两组合 + 关系一致”穷举完全一致
//    （总代价、联合最优计数、两份规范补全、每格固定性、关系表）；
//  - 跨矩阵校验（突变标识/顺序、合计未知格、单份格式限制）；
//  - 各自可解但关系矛盾 → joint-conflict 并定位首个冲突突变对；
//  - 某一份自身不可解 → joint-side-infeasible。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJointInput, solveJoint, relSymbol, REL_LABEL } from '../src/solver/joint.js';

/* ----------------------------- 穷举对拍 ----------------------------- */

function laminarCarriers(M, R, C) {
  const sets = [];
  for (let c = 0; c < C; c++) {
    let s = 0n;
    for (let r = 0; r < R; r++) if (M[r][c] === 1) s |= 1n << BigInt(r);
    sets.push(s);
  }
  for (let i = 0; i < C; i++) for (let j = i + 1; j < C; j++) {
    if (relSymbol(sets[i], sets[j]) === '!') return null;
  }
  return sets;
}

function bruteJoint(input) {
  const v = validateJointInput({ a: input.a, b: input.b });
  assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
  const A = v.data.a;
  const B = v.data.b;
  const UA = A.unknownCells.length;
  const UB = B.unknownCells.length;

  const fill = (d, m) => {
    const M = d.val.map((row) => Array.from(row));
    d.unknownCells.forEach(({ r, c }, k) => { M[r][c] = (m >> k) & 1; });
    return M;
  };
  const sideCost = (d, m) => {
    let s = 0n;
    d.unknownCells.forEach(({ r, c }, k) => {
      const id = d.uidAt[r][c];
      s += (m >> k) & 1 ? d.cost1[id] : d.cost0[id];
    });
    return s;
  };

  const optsA = [];
  for (let m = 0; m < 1 << UA; m++) {
    const M = fill(A, m);
    const sets = laminarCarriers(M, A.R, A.C);
    if (sets) optsA.push({ m, M, sets, cost: sideCost(A, m) });
  }
  const optsB = [];
  for (let m = 0; m < 1 << UB; m++) {
    const M = fill(B, m);
    const sets = laminarCarriers(M, B.R, B.C);
    if (sets) optsB.push({ m, M, sets, cost: sideCost(B, m) });
  }
  if (!optsA.length || !optsB.length) return { sideInfeasible: !optsA.length || !optsB.length };

  const consistent = (x, y) => {
    for (let i = 0; i < A.C; i++) for (let j = i + 1; j < A.C; j++) {
      if (relSymbol(x.sets[i], x.sets[j]) !== relSymbol(y.sets[i], y.sets[j])) return false;
    }
    return true;
  };

  const joint = [];
  for (const x of optsA) for (const y of optsB) {
    if (consistent(x, y)) joint.push({ x, y, cost: x.cost + y.cost });
  }
  if (!joint.length) return { conflict: true };

  let best = joint[0].cost;
  for (const f of joint) if (f.cost < best) best = f.cost;
  const opt = joint.filter((f) => f.cost === best);

  // 规范序：先 A 份问号向量（行优先）0 优先，再 B 份
  opt.sort((p, q) => {
    for (let k = 0; k < UA; k++) {
      const d = ((p.x.m >> k) & 1) - ((q.x.m >> k) & 1);
      if (d) return d;
    }
    for (let k = 0; k < UB; k++) {
      const d = ((p.y.m >> k) & 1) - ((q.y.m >> k) & 1);
      if (d) return d;
    }
    return 0;
  });

  const can0A = Array(UA).fill(false), can1A = Array(UA).fill(false);
  const can0B = Array(UB).fill(false), can1B = Array(UB).fill(false);
  for (const f of opt) {
    for (let k = 0; k < UA; k++) ((f.x.m >> k) & 1 ? can1A : can0A)[k] = true;
    for (let k = 0; k < UB; k++) ((f.y.m >> k) & 1 ? can1B : can0B)[k] = true;
  }

  return {
    status: 'joint-optimal',
    best: best.toString(),
    count: BigInt(opt.length).toString(),
    canonA: opt[0].x.M.map((row) => row.join('')).join(''),
    canonB: opt[0].y.M.map((row) => row.join('')).join(''),
    can0A, can1A, can0B, can1B,
  };
}

function checkAgainstBrute(input) {
  const b = bruteJoint(input);
  const v = validateJointInput({ a: input.a, b: input.b });
  assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
  const s = solveJoint(v.data);

  if (b.conflict || b.sideInfeasible) {
    assert.ok(s.status === 'joint-conflict' || s.status === 'joint-side-infeasible',
      `穷举无联合解但求解器返回 ${s.status}`);
    return;
  }
  assert.equal(s.status, 'joint-optimal', s.message ?? '');
  assert.equal(s.optimalCost, b.best, '联合最优总代价');
  assert.equal(s.optimalCount, b.count, '联合最优解计数');
  assert.equal(s.a.completion.map((r) => r.join('')).join(''), b.canonA, '矩阵一规范补全');
  assert.equal(s.b.completion.map((r) => r.join('')).join(''), b.canonB, '矩阵二规范补全');

  const want = (can0, can1) => (can0 && can1 ? 'variable' : can1 ? 'fixed1' : 'fixed0');
  s.a.statuses.forEach((st, k) => assert.equal(st, want(b.can0A[k], b.can1A[k]), `A 问号 ${k} 固定性`));
  s.b.statuses.forEach((st, k) => assert.equal(st, want(b.can0B[k], b.can1B[k]), `B 问号 ${k} 固定性`));

  // 关系表两行符号必须一致，且与规范补全自洽
  for (const p of s.pairs) {
    assert.equal(p.relA, p.relB, '联合最优下每份关系必须一致');
    assert.equal(p.consistent, true);
    assert.ok(p.relA !== '!');
  }
  // 总代价 = 两份分量之和
  assert.equal(
    BigInt(s.optimalCostA) + BigInt(s.optimalCostB),
    BigInt(s.optimalCost),
    '分量代价之和等于总代价',
  );
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randSide(rng, R, C, U) {
  const cellNames = Array.from({ length: R }, (_, i) => `s${i}`);
  const mutNames = Array.from({ length: C }, (_, j) => `m${j}`);
  const rows = Array.from({ length: R }, () =>
    Array.from({ length: C }, () => (rng() < 0.3 ? '1' : '0')));
  const pos = [];
  for (let i = 0; i < R * C; i++) pos.push(i);
  for (let i = pos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pos[i], pos[j]] = [pos[j], pos[i]];
  }
  for (let k = 0; k < U; k++) rows[(pos[k] / C) | 0][pos[k] % C] = '?';
  const costs = rows.map((row) => row.map((x) =>
    (x === '?' ? { c0: String(Math.floor(rng() * 4)), c1: String(Math.floor(rng() * 4)) } : null)));
  return { cellNames, mutNames, rows, costs };
}

/* ----------------------------- 随机穷举对拍 ----------------------------- */

test('随机双矩阵样例与联合穷举完全一致（代价/计数/两份规范补全/固定性/关系表）', () => {
  const rng = mulberry(20240924);
  for (let n = 0; n < 180; n++) {
    const C = 3 + Math.floor(rng() * 3);
    const RA = 4 + Math.floor(rng() * 3);
    const RB = 4 + Math.floor(rng() * 3);
    const totalU = 1 + Math.floor(rng() * 9); // 合计 ≤ 9，穷举 ≤ 512
    const UA = 1 + Math.floor(rng() * totalU);
    const UB = Math.max(0, totalU - UA);
    const a = randSide(rng, RA, C, UA);
    const b = randSide(rng, RB, C, UB);
    // 两份必须共享突变标识与顺序
    b.mutNames = a.mutNames.slice();
    // 细胞名加前缀以模拟两次测序的不同细胞集合
    a.cellNames = a.cellNames.map((x) => 'A-' + x);
    b.cellNames = b.cellNames.map((x) => 'B-' + x);
    checkAgainstBrute({ a, b });
  }
});

test('零代价时联合计数等于全部关系一致补全对数（穷举核对）', () => {
  const rng = mulberry(4242);
  for (let n = 0; n < 40; n++) {
    const C = 3 + Math.floor(rng() * 2);
    const a = randSide(rng, 4 + Math.floor(rng() * 2), C, 2 + Math.floor(rng() * 3));
    const b = randSide(rng, 4 + Math.floor(rng() * 2), C, 2 + Math.floor(rng() * 3));
    b.mutNames = a.mutNames.slice();
    for (const side of [a, b]) for (const row of side.costs) for (const cell of row) {
      if (cell) { cell.c0 = '0'; cell.c1 = '0'; }
    }
    checkAgainstBrute({ a, b });
  }
});

/* ----------------------------- 跨矩阵校验 ----------------------------- */

function side(R, C, mutNames, rows, costs) {
  return {
    cellNames: Array.from({ length: R }, (_, i) => `c${i}`),
    mutNames,
    rows,
    costs: costs ?? rows.map((row) => row.map((x) => (x === '?' ? { c0: '0', c1: '0' } : null))),
  };
}

test('突变标识与顺序必须完全一致（报首个不一致）', () => {
  const a = side(4, 3, ['x', 'y', 'z'], [
    ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'],
  ]);
  const b = side(4, 3, ['x', 'Q', 'z'], [
    ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'],
  ]);
  const r = validateJointInput({ a, b });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').includes('第 2 个突变标识不一致'));
});

test('突变数不同被拒绝', () => {
  const a = side(4, 3, ['x', 'y', 'z'], [
    ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'],
  ]);
  const b = side(4, 4, ['x', 'y', 'z', 'w'], [
    ['0', '0', '0', '0'], ['0', '0', '0', '0'], ['0', '0', '0', '0'], ['0', '0', '0', '0'],
  ]);
  const r = validateJointInput({ a, b });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').includes('突变数必须相同'));
});

test('合计未知格上限为 20，且单份仍受原格式限制', () => {
  const mk = (R, C, U) => {
    const rows = Array.from({ length: R }, () => Array(C).fill('0'));
    let k = 0;
    outer: for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      if (k++ < U) rows[i][j] = '?'; else break outer;
    }
    return side(R, C, Array.from({ length: C }, (_, j) => `m${j}`), rows);
  };
  const ok = validateJointInput({ a: mk(10, 3, 10), b: mk(10, 3, 10) });
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join(';'));

  const over = validateJointInput({ a: mk(10, 3, 11), b: mk(10, 3, 10) });
  assert.equal(over.ok, false);
  assert.ok(over.errors.join(';').includes('合计未知格不得超过 20'));

  // 单份细胞数不足 4 仍被拒绝（原有格式限制不变）
  const badSingle = validateJointInput({
    a: { ...mk(4, 3, 0), cellNames: ['a', 'b', 'c'] },
    b: mk(4, 3, 0),
  });
  assert.equal(badSingle.ok, false);
  assert.ok(badSingle.errors.some((e) => e.startsWith('矩阵一：')));
});

/* --------------------- 固定样例：联合最优的耦合效应 --------------------- */

test('联合约束会改变单看每份时的问号固定性（必须联合而非分别求解）', () => {
  // A 份 m0 在 r0、r1 两格为问号，单份（零代价）下它可成为：
  //   ∅（⊂m1）、{r0}（=m1）、{r0,r1}（⊃m1）、{r1}（与 m1 相离），四种关系都层状；
  // B 份固定 m0=m1，于是联合最优把 A 的两个问号分别钉死为 1、0。
  const a = side(4, 3, ['m0', 'm1', 'm2'], [
    ['?', '1', '0'],
    ['?', '0', '0'],
    ['0', '0', '1'],
    ['0', '0', '0'],
  ], [
    [{ c0: '0', c1: '0' }, null, null],
    [{ c0: '0', c1: '0' }, null, null],
    [null, null, null], [null, null, null],
  ]);
  const b = side(4, 3, ['m0', 'm1', 'm2'], [
    ['1', '1', '0'],
    ['0', '0', '0'],
    ['0', '0', '1'],
    ['0', '0', '0'],
  ]); // B 固定：m0=m1={r0}，与 m2 相离
  const v = validateJointInput({ a, b });
  assert.ok(v.ok);
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-optimal');
  // B 要求 m0=m1={r0}，故 A：r0 问号固定 1、r1 问号固定 0
  assert.deepEqual(s.a.statuses, ['fixed1', 'fixed0']);
  assert.equal(s.a.completion[0][0], 1);
  assert.equal(s.a.completion[1][0], 0);
  assert.equal(s.optimalCount, '1');
});

/* ----------------------------- 关系矛盾定位 ----------------------------- */

test('各自可解但关系矛盾：定位首个冲突突变对（含两份关系符号）', () => {
  // m0,m1：A 中相离，B 中 m0⊃m1
  const a = side(4, 3, ['m0', 'm1', 'm2'], [
    ['1', '0', '0'],
    ['1', '0', '0'],
    ['0', '1', '0'],
    ['0', '0', '1'],
  ]);
  const b = side(5, 3, ['m0', 'm1', 'm2'], [
    ['1', '1', '0'],
    ['1', '1', '0'],
    ['1', '0', '0'],
    ['0', '0', '1'],
    ['0', '0', '0'],
  ]);
  const v = validateJointInput({ a, b });
  assert.ok(v.ok);
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-conflict');
  assert.ok(s.conflict, '必须给出冲突对');
  assert.equal(s.conflict.mutA, 'm0');
  assert.equal(s.conflict.mutB, 'm1');
  assert.notEqual(s.conflict.relA, s.conflict.relB);
  assert.ok(REL_LABEL[s.conflict.relA] && REL_LABEL[s.conflict.relB]);
});

test('矛盾由问号补全引起（固定值无三配型冲突）时仍可定位', () => {
  // A 份问号无论如何都让 m0 与 m1 相离/包含二选一；B 固定相反方向。
  const a = side(4, 3, ['m0', 'm1', 'm2'], [
    ['?', '1', '0'],
    ['0', '1', '0'],
    ['0', '0', '1'],
    ['0', '0', '0'],
  ], [
    [{ c0: '0', c1: '0' }, null, null],
    [null, null, null], [null, null, null], [null, null, null],
  ]);
  // A: 问号取0 ⇒ m0=∅（∅⊂m1，即 m1 包含 m0）；取1 ⇒ m0=m1。
  // B 固定 m0、m1 相离：
  const b = side(4, 3, ['m0', 'm1', 'm2'], [
    ['1', '0', '0'],
    ['1', '0', '0'],
    ['0', '1', '1'],
    ['0', '0', '0'],
  ]);
  const v = validateJointInput({ a, b });
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-conflict');
  assert.equal(s.conflict.mutA, 'm0');
  assert.equal(s.conflict.mutB, 'm1');
});

/* ----------------------------- 某一份不可解 ----------------------------- */

test('某一份自身存在固定三配型冲突 → joint-side-infeasible', () => {
  const a = side(4, 3, ['m0', 'm1', 'm2'], [
    ['1', '1', '0'],
    ['1', '0', '0'],
    ['0', '1', '0'],
    ['0', '0', '0'],
  ]); // m0,m1 已 11/10/01 三配型
  const b = side(4, 3, ['m0', 'm1', 'm2'], [
    ['1', '1', '0'], ['1', '1', '0'], ['0', '0', '1'], ['0', '0', '0'],
  ]);
  const v = validateJointInput({ a, b });
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-side-infeasible');
  assert.equal(s.sideA, true);
  assert.equal(s.sideB, false);
});

/* ----------------------------- 空载体关系 ----------------------------- */

test('空载体突变按“空集包含于任意集合”参与关系一致', () => {
  // 两份 m0 在补全后都应为空（∅），m1 非空：关系都是 m0 ⊂ m1。
  const a = side(4, 3, ['m0', 'm1', 'm2'], [
    ['?', '1', '0'],
    ['0', '1', '0'],
    ['0', '0', '1'],
    ['0', '0', '0'],
  ], [
    [{ c0: '0', c1: '9', }, null, null],
    [null, null, null], [null, null, null], [null, null, null],
  ]);
  const b = side(4, 3, ['m0', 'm1', 'm2'], [
    ['0', '1', '0'], ['0', '1', '0'], ['0', '0', '1'], ['0', '0', '0'],
  ]);
  const v = validateJointInput({ a, b });
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-optimal');
  const pair01 = s.pairs.find((p) => p.mutA === 'm0' && p.mutB === 'm1');
  assert.equal(pair01.relA, '<');
  assert.equal(pair01.relB, '<');
});
