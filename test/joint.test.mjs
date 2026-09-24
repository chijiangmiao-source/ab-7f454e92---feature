// 联合复核求解器测试：
//  1) 随机小规模双矩阵与穷举完全一致（联合最优代价/计数/行优先0优先规范补全/
//     两份问号固定性/突变对关系）；
//  2) 任一单份可解而联合关系矛盾时，定位首个冲突突变对；
//  3) 校验：突变列顺序必须相同、细胞集合必须不同、合计问号 ≤ 20。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJointInput, solveJoint, REL_SYMBOL } from '../src/solver/joint.js';

function relOfSets(Ma, Mb, R, i, j) {
  const carr = (M, c) => {
    let s = 0;
    for (let r = 0; r < R; r++) if (M[r][c] === 1) s |= 1 << r;
    return s;
  };
  const A = carr(Ma, i), B = carr(Ma, j);
  const C = carr(Mb, i), D = carr(Mb, j);
  const rel = (X, Y) => {
    if (X === Y) return '=';
    const inter = X & Y;
    if (inter === 0) return '∥';
    if (inter === X) return '⊂';
    if (inter === Y) return '⊃';
    return 'X'; // 交叉
  };
  return { ra: rel(A, B), rb: rel(C, D) };
}

function laminar(M, R, C) {
  for (let i = 0; i < C; i++) for (let j = i + 1; j < C; j++) {
    const { ra } = relOfSets(M, M, R, i, j);
    if (ra === 'X') return false;
  }
  return true;
}

// 穷举联合解：枚举两份问号全部取值，仅保留各自层状且逐对关系一致者
function bruteJoint(d) {
  const ua = d.a.unknownCells.length, ub = d.b.unknownCells.length;
  const sols = [];
  for (let ma = 0; ma < 1 << ua; ma++) {
    const Ma = d.a.val.map((row) => Array.from(row));
    d.a.unknownCells.forEach(({ r, c }, k) => { Ma[r][c] = (ma >> k) & 1; });
    if (!laminar(Ma, d.a.R, d.a.C)) continue;
    let ca = 0n;
    d.a.unknownCells.forEach(({ r, c }, k) => {
      const id = d.a.uidAt[r][c];
      ca += (ma >> k) & 1 ? d.a.cost1[id] : d.a.cost0[id];
    });
    for (let mb = 0; mb < 1 << ub; mb++) {
      const Mb = d.b.val.map((row) => Array.from(row));
      d.b.unknownCells.forEach(({ r, c }, k) => { Mb[r][c] = (mb >> k) & 1; });
      if (!laminar(Mb, d.b.R, d.b.C)) continue;
      let ok = true;
      for (let i = 0; i < d.a.C && ok; i++) for (let j = i + 1; j < d.a.C; j++) {
        if (relOn(Ma, d.a.R, i, j) !== relOn(Mb, d.b.R, i, j)) { ok = false; break; }
      }
      if (!ok) continue;
      let cb = 0n;
      d.b.unknownCells.forEach(({ r, c }, k) => {
        const id = d.b.uidAt[r][c];
        cb += (mb >> k) & 1 ? d.b.cost1[id] : d.b.cost0[id];
      });
      // 规范键：先 A 后 B，每份问号按 uid 行优先，0 优先
      const keyA = bitsKey(ma, ua), keyB = bitsKey(mb, ub);
      sols.push({ ma, mb, Ma, Mb, cost: ca + cb, keyA, keyB });
    }
  }
  if (!sols.length) return null;
  let best = sols[0].cost;
  for (const s of sols) if (s.cost < best) best = s.cost;
  const opt = sols.filter((s) => s.cost === best);
  opt.sort((p, q) => (p.keyA < q.keyA ? -1 : p.keyA > q.keyA ? 1 : p.keyB < q.keyB ? -1 : p.keyB > q.keyB ? 1 : 0));
  const can0A = Array(ua).fill(false), can1A = Array(ua).fill(false);
  const can0B = Array(ub).fill(false), can1B = Array(ub).fill(false);
  for (const s of opt) {
    for (let k = 0; k < ua; k++) ((s.ma >> k) & 1 ? can1A : can0A)[k] = true;
    for (let k = 0; k < ub; k++) ((s.mb >> k) & 1 ? can1B : can0B)[k] = true;
  }
  return {
    best: best.toString(),
    count: BigInt(opt.length).toString(),
    canonA: opt[0].Ma.map((r) => r.join('')).join(''),
    canonB: opt[0].Mb.map((r) => r.join('')).join(''),
    can0A, can1A, can0B, can1B,
    relOnCanon: pairRels(opt[0].Ma, d.a.R, opt[0].Mb, d.b.R, d.a.C),
  };
}

function bitsKey(m, n) {
  let s = '';
  for (let k = 0; k < n; k++) s += (m >> k) & 1;
  return s;
}

function relOn(M, R, i, j) {
  const carr = (c) => {
    let s = 0;
    for (let r = 0; r < R; r++) if (M[r][c] === 1) s |= 1 << r;
    return s;
  };
  const X = carr(i), Y = carr(j);
  if (X === Y) return '=';
  const inter = X & Y;
  if (inter === 0) return '∥';
  if (inter === X) return '⊂';
  if (inter === Y) return '⊃';
  return 'X';
}

function pairRels(Ma, Ra, Mb, Rb, C) {
  const out = [];
  for (let i = 0; i < C; i++) for (let j = i + 1; j < C; j++) {
    out.push({ i, j, ra: relOn(Ma, Ra, i, j), rb: relOn(Mb, Rb, i, j) });
  }
  return out;
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// 构造一对必然“联合可行”的随机矩阵：
// 蓝图把行切成若干不交块；每个突变归属一块并取该块前 depth 行作为载体。
// 同块突变的载体按 depth 成前缀包含/相等，异块突变相离；两份各自独立的细胞
// 排列保持相同块结构（仅细胞名不同），故任意两份补全天然共享突变对关系。
// 之后随机把若干固定格改挖为问号并赋予随机代价，产生丰富的最优分歧。
function randCompatiblePair(rng) {
  const R = 4 + Math.floor(rng() * 2);
  const C = 3 + Math.floor(rng() * 2);

  const G = 1 + Math.floor(rng() * Math.min(2, R - 1));
  const blockSize = Array(G).fill(1);
  for (let r = G; r < R; r++) blockSize[Math.floor(rng() * G)]++;
  const blockStart = [];
  let acc = 0;
  for (const sz of blockSize) { blockStart.push(acc); acc += sz; }

  const blueprint = Array.from({ length: C }, () => {
    const g = Math.floor(rng() * G);
    const depth = Math.floor(rng() * (blockSize[g] + 1));
    return { g, depth };
  });

  const build = (prefix) => {
    // 该份细胞排列：各块内部随机洗牌，块顺序不变（块大小结构相同）
    const perm = [];
    blockSize.forEach((sz, g) => {
      const seg = [];
      for (let r = blockStart[g]; r < blockStart[g] + sz; r++) seg.push(r);
      for (let i = seg.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [seg[i], seg[j]] = [seg[j], seg[i]];
      }
      perm.push(...seg);
    });
    const carrierRows = blueprint.map(({ g, depth }) => {
      const set = new Set(perm.slice(blockStart[g], blockStart[g] + depth));
      return set;
    });
    const rows = Array.from({ length: R }, (_, r) =>
      Array.from({ length: C }, (_, c) => (carrierRows[c].has(r) ? '1' : '0')));

    const U = Math.floor(rng() * 7);
    const pos = [];
    for (let i = 0; i < R * C; i++) pos.push(i);
    for (let i = pos.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pos[i], pos[j]] = [pos[j], pos[i]];
    }
    for (let k = 0; k < U; k++) rows[(pos[k] / C) | 0][pos[k] % C] = '?';

    return {
      cellNames: Array.from({ length: R }, (_, i) => `${prefix}${i}`),
      mutNames: Array.from({ length: C }, (_, j) => `m${j}`),
      rows,
      costs: rows.map((row) => row.map((x) =>
        (x === '?' ? { c0: String(Math.floor(rng() * 4)), c1: String(Math.floor(rng() * 4)) } : null))),
    };
  };

  return { a: build('a'), b: build('b') };
}

test('随机双矩阵：联合结果与穷举完全一致', () => {
  const rng = mulberry(20240924);
  for (let n = 0; n < 120; n++) {
    const inp = randCompatiblePair(rng);
    const v = validateJointInput(inp);
    assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
    const s = solveJoint(v.data);
    const br = bruteJoint(v.data);
    assert.ok(br, `构造样例联合必可解，case ${n} 却无解`);
    assert.equal(s.status, 'optimal', `case ${n}`);
    assert.equal(s.optimalCost, br.best, '联合最优总代价');
    assert.equal(s.optimalCount, br.count, '联合最优解计数');
    const canonA = s.a.completion.map((r) => r.join('')).join('');
    const canonB = s.b.completion.map((r) => r.join('')).join('');
    assert.equal(canonA, br.canonA, 'A 行优先0优先规范补全');
    assert.equal(canonB, br.canonB, 'B 行优先0优先规范补全');
    v.data.a.unknownCells.forEach((_, k) => {
      const want = br.can0A[k] && br.can1A[k] ? 'variable' : br.can1A[k] ? 'fixed1' : 'fixed0';
      assert.equal(s.a.statuses[k], want, `A 问号 ${k} 联合固定性`);
    });
    v.data.b.unknownCells.forEach((_, k) => {
      const want = br.can0B[k] && br.can1B[k] ? 'variable' : br.can1B[k] ? 'fixed1' : 'fixed0';
      assert.equal(s.b.statuses[k], want, `B 问号 ${k} 联合固定性`);
    });
    for (const p of s.pairs) {
      const want = br.relOnCanon.find((q) => q.i === p.i && q.j === p.j);
      assert.equal(p.relSymbol, want.ra, `关系表 ${p.mutA} ${p.mutB}（A）`);
      assert.equal(p.consistent, want.ra === want.rb);
    }
  }
});

test('固定矛盾：两份各自可解，但 m0/m1 关系被固定值逼成相反 → joint-conflict 且定位首个冲突对', () => {
  // A：m0 ⊃ m1（见证 11=a0, 10=a1）；B：m0 ⊂ m1（见证 11=b0, 01=b1）
  const A = {
    cellNames: ['a0', 'a1', 'a2', 'a3'], mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  const B = {
    cellNames: ['b0', 'b1', 'b2', 'b3'], mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['0', '1', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  const v = validateJointInput({ a: A, b: B });
  assert.ok(v.ok, v.ok ? '' : v.errors.join(';'));
  const s = solveJoint(v.data);
  assert.equal(s.status, 'joint-conflict');
  // 列序：c=0(m0) 先选定，c=1(m1) 无合法配对 → 首个失败列 mutA=m1，历史列 mutB=m0
  assert.equal(s.conflict.mutA, 'm1');
  assert.equal(s.conflict.mutB, 'm0');
  assert.equal(s.conflict.indexA, 1);
  assert.equal(s.conflict.indexB, 0);
});

test('单份固定三配型冲突仍报 fixed-conflict（各自沿用原规则）', () => {
  const A = {
    cellNames: ['a0', 'a1', 'a2', 'a3'], mutNames: ['m0', 'm1', 'm2'],
    rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '1', '0'], ['0', '0', '0']],
    costs: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  const B = {
    cellNames: ['b0', 'b1', 'b2', 'b3'], mutNames: ['m0', 'm1', 'm2'],
    rows: [['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
  };
  const v = validateJointInput({ a: A, b: B });
  assert.ok(v.ok);
  const s = solveJoint(v.data);
  assert.equal(s.status, 'fixed-conflict');
  assert.equal(s.conflictsA.length, 1);
  assert.equal(s.conflictsB.length, 0);
});

test('校验：突变标识/顺序不同、细胞集合相同、合计问号超限均拒绝（单份规则不变）', () => {
  const mk = (cells, muts, rows) => ({
    cellNames: cells, mutNames: muts, rows,
    costs: rows.map((r) => r.map((x) => (x === '?' ? { c0: '0', c1: '0' } : null))),
  });
  const A = mk(['a0', 'a1', 'a2', 'a3'], ['m0', 'm1', 'm2'],
    [['?', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']]);

  const diffMuts = mk(['b0', 'b1', 'b2', 'b3'], ['m0', 'X', 'm2'],
    [['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']]);
  assert.equal(validateJointInput({ a: A, b: diffMuts }).ok, false);

  const sameCells = mk(['a0', 'a1', 'a2', 'a3'], ['m0', 'm1', 'm2'],
    [['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']]);
  assert.equal(validateJointInput({ a: A, b: sameCells }).ok, false);

  // 合计 21 个问号
  const big = mk(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'], ['m0', 'm1', 'm2'],
    Array.from({ length: 7 }, () => ['?', '?', '?']));
  const A20 = mk(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'], ['m0', 'm1', 'm2'],
    Array.from({ length: 7 }, (_, r) => (r === 0 ? ['0', '0', '?'] : ['?', '?', '?'])));
  const v = validateJointInput({ a: A20, b: big }); // 20 + 21 = 41? 构造超过 20
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(';').includes('20'));
});
