// 联合复核求解器：同一组突变（标识与列序完全相同）在两份「细胞集合不同」的
// 靶向测序矩阵上的最小代价补全，必须逐对突变共享同一种集合关系
// （包含 ⊃、被包含 ⊂、相等 =、相离 ∥），并在该前提下精确最小化两份代价之和。
//
// 关键：本文件**绝不**先各自调用单矩阵求解器再比较结果。两份补全的关系一致性
// 在同一次列序搜索中作为剪枝条件：为第 c 个突变同时选取两份载体集合 (A,B) 时，
// 立即要求 (A,B) 与此前每一对载体集合层状同关系（rel(A,X)=rel(B,Y)）。
// 因此最优代价、最优解计数、逐问号固定性与行优先 0 优先规范补全，全部都是
// “联合最优解”这一解集上的统计量。
//
// 规模：每份 4–18 细胞、3–12 突变、单份问号 ≤28，两份合计问号 ≤20。

import {
  validateInput,
  buildModel,
  buildFamilyStructure,
  candidates,
  lowestBitIndex,
} from './core.js';
import { JOINT_LIMITS } from './joint-consts.js';

const REL = { DISJOINT: 0, EQUAL: 1, CONTAINS: 2, CONTAINED: 3 };

function relOf(A, B) {
  if (A === B) return REL.EQUAL;
  const inter = A & B;
  if (inter === 0n) return REL.DISJOINT;
  if (inter === A) return REL.CONTAINED; // A ⊂ B
  if (inter === B) return REL.CONTAINS; // A ⊃ B
  return -1; // 交叉，非层状
}

export const REL_LABEL = {
  [REL.DISJOINT]: '相离',
  [REL.EQUAL]: '相等',
  [REL.CONTAINS]: '包含',
  [REL.CONTAINED]: '被包含',
};
export const REL_SYMBOL = {
  [REL.DISJOINT]: '∥',
  [REL.EQUAL]: '=',
  [REL.CONTAINS]: '⊃',
  [REL.CONTAINED]: '⊂',
};

/* ------------------------- 联合输入校验 ------------------------- */

export function validateJointInput(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['输入必须为 JSON 对象 {a, b}。'] };
  }
  if (!raw.a || !raw.b) {
    return { ok: false, errors: ['需要两份矩阵 a 与 b。'] };
  }

  // 各自沿用原有格式限制（含规模、字符、重名、代价等）
  const va = validateOne(raw.a, '矩阵 A');
  const vb = validateOne(raw.b, '矩阵 B');
  if (va.errors.length || vb.errors.length) {
    return { ok: false, errors: [...va.errors, ...vb.errors] };
  }
  const da = va.data;
  const db = vb.data;

  // 突变标识及顺序相同
  if (da.C !== db.C || da.mutNames.some((nm, j) => nm !== db.mutNames[j])) {
    errors.push('两份矩阵的突变标识及列顺序必须完全相同。');
  }
  // 细胞集合不同：数量不同，或同一行位上的名称不同
  const sameCells =
    da.R === db.R && da.cellNames.every((nm, i) => nm === db.cellNames[i]);
  if (sameCells) {
    errors.push('两份矩阵的细胞集合必须不同（细胞名称列表需代表两次测序的不同细胞集）。');
  }
  // 合计未知格
  const ua = da.unknownCells.length;
  const ub = db.unknownCells.length;
  if (ua + ub > JOINT_LIMITS.maxUnknownTotal) {
    errors.push(`两个矩阵合计未知格不得超过 ${JOINT_LIMITS.maxUnknownTotal}，当前为 ${ua + ub}（A ${ua}、B ${ub}）。`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { a: da, b: db } };
}

// 复用单份校验的全部规则（规模、字符、重名、代价…）；单份问号上限按联合模式放宽，
// 总数 20 的限制在外层按两份合计另行检查。
function validateOne(raw, tag) {
  const checked = validateInput(raw, { maxUnknown: JOINT_LIMITS.maxUnknownTotal });
  if (!checked.ok) {
    return { errors: checked.errors.map((e) => `【${tag}】${e}`), data: null };
  }
  return { errors: [], data: checked.data };
}

/* ------------------------- 联合搜索 ------------------------- */

function makeJointSearch(ma, mb) {
  const C = ma.C;
  const ZA = Array(C).fill(0n);
  const ZB = Array(C).fill(0n);

  // 缓存：与单份一致地按 (列, 已选集合族键, 种子) 缓存各自候选
  const caches = [makeCache(ma), makeCache(mb)];
  function makeCache(model) {
    const cand = new Map();
    const struct = new Map();
    const keyOf = (c, fk, inc, exc) =>
      c + '|' + fk + '|' + inc[c].toString(36) + '|' + exc[c].toString(36);
    return {
      struct(familyKey, family) {
        let s = struct.get(familyKey);
        if (!s) { s = buildFamilyStructure(family); struct.set(familyKey, s); }
        return s;
      },
      list(c, familyKey, family, inc, exc) {
        const k = keyOf(c, familyKey, inc, exc);
        let l = cand.get(k);
        if (!l) {
          l = candidates(model, c, this.struct(familyKey, family), inc[c], exc[c]);
          cand.set(k, l);
        }
        return l;
      },
      sorted(c, familyKey, family, inc, exc) {
        return this.list(c, familyKey, family, inc, exc).slice().sort(byCost);
      },
    };
  }
  const byCost = (x, y) => (x.cost < y.cost ? -1 : x.cost > y.cost ? 1 : x.S < y.S ? -1 : x.S > y.S ? 1 : 0);

  const fkey = (fam) => fam.map((s) => s.toString(36)).join(',');

  /* ---- 联合配对候选 ----
     pairs：此前各列按列对齐的 {A,B} 配对序列（允许同一克隆重复配对，跨份对应
     关系不可丢失）。候选生成只需各侧投影去重后的载体集合族；跨份关系一致性
     检查则必须用有序对齐的 pairs。 */
  const pairCache = new Map();
  function pairCandidates(c, pairs, incA, excA, incB, excB) {
    const famA = distinctMasks(pairs.map((p) => p.A));
    const famB = distinctMasks(pairs.map((p) => p.B));
    const ka = fkey(famA);
    const kb = fkey(famB);
    const pk = orderedPairKey(pairs);
    const cacheKey =
      c + '#' + ka + '#' + kb + '#' + pk +
      '#' + incA[c].toString(36) + ':' + excA[c].toString(36) +
      '#' + incB[c].toString(36) + ':' + excB[c].toString(36);
    let pc = pairCache.get(cacheKey);
    if (pc) return pc;

    const la = caches[0].list(c, ka, famA, incA, excA);
    const lb = caches[1].list(c, kb, famB, incB, excB);
    pc = [];
    // A、B 两侧候选数均极小（层状候选），直接双循环。
    // 注意：同一突变 c 在两份中的载体 (x,y) 分属不同细胞集，二者之间**没有**
    // 层状要求；联合约束只针对“突变对”——对每个历史配对，两侧关系必须同名。
    for (const x of la) {
      for (const y of lb) {
        if (!consistentWithPairs(x.S, y.S, pairs)) continue;
        pc.push({ A: x.S, B: y.S, cost: x.cost + y.cost });
      }
    }
    pc.sort((p, q) => (p.cost < q.cost ? -1 : p.cost > q.cost ? 1
      : p.A < q.A ? -1 : p.A > q.A ? 1 : p.B < q.B ? -1 : p.B > q.B ? 1 : 0));
    pairCache.set(cacheKey, pc);
    return pc;
  }

  /* ---- 联合最小代价（分支限界） ---- */
  function minimize() {
    let upper = null;

    // 贪心：每列取当前联合代价最小的合法配对
    const greedy = (c, pairs) => {
      if (c === C) return { cost: 0n, A: [], B: [] };
      const list = pairCandidates(c, pairs, ZA, ZB, ZA, ZB);
      for (const p of list) {
        const rest = greedy(c + 1, [...pairs, { A: p.A, B: p.B }]);
        if (rest) return { cost: p.cost + rest.cost, A: [p.A, ...rest.A], B: [p.B, ...rest.B] };
      }
      return null;
    };
    const g = greedy(0, []);
    if (!g) return null;
    upper = g.cost;

    // 下界：各份每列独立最小候选代价（忽略跨列与跨份约束，仍是合法 LB）
    const suffixLB = Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      let a = null, b = null;
      for (const cand of caches[0].list(c, '', [], ZA, ZA)) a = a === null || cand.cost < a ? cand.cost : a;
      for (const cand of caches[1].list(c, '', [], ZB, ZB)) b = b === null || cand.cost < b ? cand.cost : b;
      suffixLB[c] = suffixLB[c + 1] + (a ?? 0n) + (b ?? 0n);
    }

    const dfs = (c, pairs, spent) => {
      if (spent + suffixLB[c] >= upper) return;
      if (c === C) { if (spent < upper) upper = spent; return; }
      const list = pairCandidates(c, pairs, ZA, ZB, ZA, ZB);
      for (const p of list) {
        if (spent + p.cost + suffixLB[c + 1] >= upper) break; // 升序
        pairs.push({ A: p.A, B: p.B });
        dfs(c + 1, pairs, spent + p.cost);
        pairs.pop();
        if (upper === 0n) return;
      }
    };
    dfs(0, [], 0n);
    return { cost: upper, greedyA: g.A, greedyB: g.B };
  }

  /* ---- 联合有界可行性：是否存在总代价 <= bound（支持各自问号种子） ---- */
  function exists(seedsA, seedsB, bound) {
    const { inc: incA, exc: excA } = seedOf(ma, seedsA);
    const { inc: incB, exc: excB } = seedOf(mb, seedsB);

    const suffixLB = Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      suffixLB[c] = suffixLB[c + 1] + colLocalMin(ma, c, incA, excA) + colLocalMin(mb, c, incB, excB);
    }

    const dfs = (c, pairs, spent) => {
      if (spent > bound || spent + suffixLB[c] > bound) return false;
      if (c === C) return true;
      const list = pairCandidates(c, pairs, incA, excA, incB, excB);
      for (const p of list) {
        if (spent + p.cost + suffixLB[c + 1] > bound) break;
        pairs.push({ A: p.A, B: p.B });
        if (dfs(c + 1, pairs, spent + p.cost)) { pairs.pop(); return true; }
        pairs.pop();
      }
      return false;
    };
    return dfs(0, [], 0n);
  }

  /* ---- 联合精确计数：记忆化 (列序, 已出现的不同跨份载体配对, 代价窗口) ---- */
  // 未来列的合法性只依赖“此前各列所选 (A,B) 配对的去重集合”：
  // 新配对 (Z,W) 合法 ⇔ 对每个已出现配对 (X,Y) 有 rel(Z,X)=rel(W,Y)，
  // 且 Z 与 A 侧不同集合层状、W 与 B 侧不同集合层状（均可由配对集合投影得到）。
  // 注意同一 A 克隆可能在另一测序中对应两个不同 B 集合（反之亦然），故不能只存
  // 各自去重集合族；配对的对应关系一旦丢失会错误放过矛盾配对。
  function makeCounter(limit) {
    const memo = new Map();
    let nodes = 0;

    const sufMin = Array(C + 1).fill(0n);
    const sufMax = Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      const [a0, a1] = minMax(ma, c);
      const [b0, b1] = minMax(mb, c);
      sufMin[c] = sufMin[c + 1] + a0 + b0;
      sufMax[c] = sufMax[c + 1] + a1 + b1;
    }

    const cmpPair = (p, q) => (p.A < q.A ? -1 : p.A > q.A ? 1 : p.B < q.B ? -1 : p.B > q.B ? 1 : 0);

    const dist = (c, pairs, lo, hi) => {
      if (lo > hi || hi < 0n) return EMPTY;
      if (sufMin[c] > hi || sufMax[c] < lo) return EMPTY;
      if (c === C) return lo <= 0n && 0n <= hi ? ONE : EMPTY;

      // 记忆状态 = 已出现的不同跨份 (A,B) 配对（排序规范化）：
      // 候选生成只需各侧投影去重族；跨份关系检查必须用配对对应（函数内部处理）。
      const key = c + '#' + orderedPairKey(pairs) + '#' + lo.toString() + '#' + hi.toString();
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      if (++nodes > limit) throw new Error('联合计数节点数超出安全上限，未知格结构过于复杂。');

      const list = pairCandidates(c, pairs, ZA, ZB, ZA, ZB);
      const out = new Map();
      for (const p of list) {
        if (p.cost > hi) break; // pairCandidates 按代价升序
        if (p.cost + sufMin[c + 1] > hi || p.cost + sufMax[c + 1] < lo) continue;
        let np = pairs;
        if (!pairs.some((q) => q.A === p.A && q.B === p.B)) {
          np = [...pairs, { A: p.A, B: p.B }].sort(cmpPair);
        }
        const sub = dist(c + 1, np, lo - p.cost, hi - p.cost);
        for (const [k, v] of sub) {
          const t = k + p.cost;
          if (t >= lo && t <= hi) out.set(t, (out.get(t) ?? 0n) + v);
        }
      }
      const result = out.size ? out : EMPTY;
      memo.set(key, result);
      return result;
    };

    return {
      countAt(target) { return dist(0, [], target, target).get(target) ?? 0n; },
      get nodes() { return nodes; },
    };
  }

  return { minimize, exists, makeCounter, pairCandidates, C };
}

function distinctMasks(list) {
  const out = [];
  for (const x of list) if (!out.includes(x)) out.push(x);
  out.sort(cmpMask);
  return out;
}

// 按列对齐的配对序列的规范键（允许同一克隆重复配对，保留跨份对应）
function orderedPairKey(pairs) {
  return pairs.map((p) => p.A.toString(36) + ':' + p.B.toString(36)).join(',');
}

// (A,B) 是否与每个已选跨份配对 (X,Y) 关系一致
function consistentWithPairs(A, B, pairs) {
  for (const { A: X, B: Y } of pairs) {
    if (relOf(A, X) !== relOf(B, Y)) return false;
  }
  return true;
}

const EMPTY = new Map();
const ONE = new Map([[0n, 1n]]);
const cmpMask = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function seedOf(model, seeds) {
  const inc = Array(model.C).fill(0n);
  const exc = Array(model.C).fill(0n);
  for (const [uid, v] of seeds) {
    const { r, c } = model.unknownCells[uid];
    const bit = 1n << BigInt(r);
    if (v === 1) inc[c] |= bit; else exc[c] |= bit;
  }
  return { inc, exc };
}

function colLocalMin(model, c, inc, exc) {
  // 忽略跨列层状约束的该列最小代价（合法下界分量）
  let s = 0n;
  for (const { r, uid } of model.colUnknowns[c]) {
    const bit = 1n << BigInt(r);
    if ((inc[c] & bit) !== 0n) s += model.cost1[uid];
    else if ((exc[c] & bit) !== 0n) s += model.cost0[uid];
    else s += model.cost0[uid] < model.cost1[uid] ? model.cost0[uid] : model.cost1[uid];
  }
  return s;
}

function minMax(model, c) {
  let lo = 0n, hi = 0n;
  for (const { uid } of model.colUnknowns[c]) {
    const a = model.cost0[uid], b = model.cost1[uid];
    lo += a < b ? a : b;
    hi += a > b ? a : b;
  }
  return [lo, hi];
}

/* ------------------------- 不可行诊断：首个冲突突变对 ------------------------- */
// 两份各自并无固定三配型冲突（调用前已查），但不存在关系一致的联合补全时，
// 定位“首个”冲突突变对：按列序贪心推进联合搜索，找到第一个没有合法配对的列，
// 并给出导致失败的关系见证（两份各自需要的关系与矛盾来源）。
function firstConflict(modelA, modelB, search) {
  const C = modelA.C;
  const pairs = [];
  for (let c = 0; c < C; c++) {
    const list = search.pairCandidates(c, pairs,
      Array(C).fill(0n), Array(C).fill(0n), Array(C).fill(0n), Array(C).fill(0n));
    if (!list.length) {
      return explainPair(modelA, modelB, c, pairs);
    }
    // 贪心：联合代价最小的配对优先，尽量贴近最优搜索的失败点
    const p = list[0];
    pairs.push({ A: p.A, B: p.B });
  }
  return null;
}

function explainPair(modelA, modelB, c, pairs) {
  // 贪心前缀（与最小代价搜索同一配对裁决顺序）下，列 c 已无任何合法配对。
  // 找最早的历史列 t，使“任意 A 候选 × 任意 B 候选”与 t 的关系都不一致
  // （rPastA != rPastB）——即联合可行性被突变对 (c,t) 强制矛盾。
  const pastA = distinctMasks(pairs.map((p) => p.A));
  const pastB = distinctMasks(pairs.map((p) => p.B));
  const la = candidates(modelA, c, buildFamilyStructure(pastA), 0n, 0n);
  const lb = candidates(modelB, c, buildFamilyStructure(pastB), 0n, 0n);

  // 某侧自身已无层状候选：联合无解的根因在该侧单份（非跨份关系矛盾）
  if (!la.length || !lb.length) {
    return {
      kind: 'side-infeasible',
      mutA: modelA.mutNames[c],
      mutB: null,
      side: !la.length ? 'A' : 'B',
      indexA: c,
      indexB: -1,
      message: `首个失败突变：「${modelA.mutNames[c]}」——矩阵 ${!la.length ? 'A' : 'B'} 中该突变的任何问号取值都无法与本侧已决定的载体集合构成层状关系。`,
      witnesses: [],
    };
  }

  let firstT = -1;
  let witnessDetail = null;
  for (let t = 0; t < pairs.length; t++) {
    let blocked = true;
    let sample = null;
    for (const x of la) {
      for (const y of lb) {
        const rPastA = relOf(x.S, pairs[t].A);
        const rPastB = relOf(y.S, pairs[t].B);
        if (rPastA === rPastB) { blocked = false; break; }
        if (!sample) sample = { rPastA, rPastB, Ac: x.S, Bc: y.S, At: pairs[t].A, Bt: pairs[t].B };
      }
      if (!blocked) break;
    }
    if (blocked) { firstT = t; witnessDetail = sample; }
  }
  void pastA; void pastB;

  const mutA = modelA.mutNames[c];
  const other = firstT >= 0 ? modelA.mutNames[firstT] : null;
  const witnesses = firstT >= 0 && witnessDetail
    ? relationWitnesses(modelA, modelB, c, firstT, witnessDetail)
    : [];

  return {
    kind: 'joint-relation',
    mutA,
    mutB: other,
    indexA: c,
    indexB: firstT,
    message: other
      ? `首个冲突突变对：「${mutA}」与「${other}」——两份矩阵中二者的载体集合关系无法同时成立。`
      : `首个冲突突变：「${mutA}」——联合层状约束在此列无法继续（前缀贪心已按联合代价最小裁决）。`,
    witnesses,
  };
}

// 给出该冲突对在两份矩阵中的关系与具体细胞见证（11/10/01 各取最低位细胞）
function relationWitnesses(modelA, modelB, c, t, d) {
  return [
    {
      side: 'A',
      mutX: modelA.mutNames[c], mutY: modelA.mutNames[t],
      rel: d.rPastA >= 0 ? REL_LABEL[d.rPastA] : '交叉',
      cells: patCells(modelA, d.Ac, d.At),
    },
    {
      side: 'B',
      mutX: modelB.mutNames[c], mutY: modelB.mutNames[t],
      rel: d.rPastB >= 0 ? REL_LABEL[d.rPastB] : '交叉',
      cells: patCells(modelB, d.Bc, d.Bt),
    },
  ];
}

function patCells(model, X, Y) {
  const grab = (mask) => (mask !== 0n ? model.cellNames[lowestBitIndex(mask)] : null);
  return { w11: grab(X & Y), w10: grab(X & ~Y), w01: grab(Y & ~X) };
}

/* ------------------------- 规范补全与问号固定性 ------------------------- */

function materializePair(model, carriers) {
  const completion = model.val.map((row) => Int8Array.from(row));
  for (let r = 0; r < model.R; r++) {
    const bit = 1n << BigInt(r);
    for (let c = 0; c < model.C; c++) {
      if (completion[r][c] === -1) completion[r][c] = (carriers[c] & bit) !== 0n ? 1 : 0;
    }
  }
  return completion;
}

/* ------------------------- 主入口 ------------------------- */

export function solveJoint(data, limits = {}) {
  const countNodeLimit = limits.countNodes ?? JOINT_LIMITS.countNodeLimit;
  const da = data.a, db = data.b;
  const ma = buildModel(da), mb = buildModel(db);
  ma.cellNames = da.cellNames; ma.mutNames = da.mutNames;
  mb.cellNames = db.cellNames; mb.mutNames = db.mutNames;

  // 1) 各自的固定三配型冲突仍按原规则检测（不做联合时也各自有意义）
  const fixedA = fixedTripleConflicts(ma, da);
  const fixedB = fixedTripleConflicts(mb, db);
  if (fixedA.length || fixedB.length) {
    return { status: 'fixed-conflict', conflictsA: fixedA, conflictsB: fixedB };
  }

  const search = makeJointSearch(ma, mb);

  // 2) 联合最小总代价（一次性联合搜索，非分别求解）
  const best = search.minimize();
  if (best === null) {
    return { status: 'joint-conflict', conflict: firstConflict(ma, mb, search) };
  }
  const bestCost = best.cost;

  // 3) 两份各自问号在“全部联合最优解”中的固定性
  const fixSide = (model, which) => {
    const U = model.unknownCells.length;
    const statuses = new Array(U);
    for (let uid = 0; uid < U; uid++) {
      const seeds0 = [[uid, 0]];
      const seeds1 = [[uid, 1]];
      const can0 = which === 'A'
        ? search.exists(seeds0, [], bestCost)
        : search.exists([], seeds0, bestCost);
      const can1 = which === 'A'
        ? search.exists(seeds1, [], bestCost)
        : search.exists([], seeds1, bestCost);
      statuses[uid] = can0 && can1 ? 'variable' : can1 ? 'fixed1' : 'fixed0';
    }
    return statuses;
  };
  const statusesA = fixSide(ma, 'A');
  const statusesB = fixSide(mb, 'B');

  // 4) 行优先、0 优先的联合规范补全：
  //    先 A 后 B，每份内按问号行优先（uid 升序）逐格 0 优先，
  //    每一步都在“联合最优总代价”可行域内裁决。
  const seedsA = [], seedsB = [];
  const assignSide = (model, statuses, seeds, which) => {
    const U = model.unknownCells.length;
    const assignment = new Int8Array(U);
    for (let uid = 0; uid < U; uid++) {
      const try0 = [...seeds, [uid, 0]];
      const feasible = which === 'A'
        ? search.exists(try0, seedsB, bestCost)
        : search.exists(seedsA, try0, bestCost);
      if (feasible) { assignment[uid] = 0; seeds.push([uid, 0]); }
      else { assignment[uid] = 1; seeds.push([uid, 1]); }
    }
    return assignment;
  };
  const assignmentA = assignSide(ma, statusesA, seedsA, 'A');
  const assignmentB = assignSide(mb, statusesB, seedsB, 'B');

  // 5) 联合最优解总数（任意精度）
  const counter = search.makeCounter(countNodeLimit);
  const optimalCount = counter.countAt(bestCost);

  // 6) 还原两份规范矩阵
  const carriersOf = (model, assignment) => {
    const carriers = new Array(model.C);
    for (let c = 0; c < model.C; c++) {
      let S = model.fixed1[c];
      for (const { r, uid } of model.colUnknowns[c]) {
        if (assignment[uid] === 1) S |= 1n << BigInt(r);
      }
      carriers[c] = S;
    }
    return carriers;
  };
  const carriersA = carriersOf(ma, assignmentA);
  const carriersB = carriersOf(mb, assignmentB);
  const completionA = materializePair(ma, carriersA);
  const completionB = materializePair(mb, carriersB);

  // 7) 可由两份结果复核的突变对关系表（规范补全下的关系，必为同一种）
  const pairs = buildPairTable(ma, mb, carriersA, carriersB);

  // 8) 代价分量（仅用于展示分份合计）
  const sumCost = (model, assignment) => {
    let s = 0n;
    model.unknownCells.forEach((_, uid) => {
      s += assignment[uid] === 1 ? model.cost1[uid] : model.cost0[uid];
    });
    return s;
  };
  const costA = sumCost(ma, assignmentA);
  const costB = sumCost(mb, assignmentB);

  return {
    status: 'optimal',
    mutNames: ma.mutNames.slice(),
    optimalCost: bestCost.toString(),
    optimalCostA: costA.toString(),
    optimalCostB: costB.toString(),
    optimalCount: optimalCount.toString(),
    a: {
      R: ma.R, C: ma.C,
      cellNames: ma.cellNames.slice(),
      mutNames: ma.mutNames.slice(),
      assignment: Array.from(assignmentA),
      statuses: statusesA,
      completion: completionA.map((row) => Array.from(row)),
      unknownCells: ma.unknownCells,
      carriers: carriersA.map((s) => s.toString()),
    },
    b: {
      R: mb.R, C: mb.C,
      cellNames: mb.cellNames.slice(),
      mutNames: mb.mutNames.slice(),
      assignment: Array.from(assignmentB),
      statuses: statusesB,
      completion: completionB.map((row) => Array.from(row)),
      unknownCells: mb.unknownCells,
      carriers: carriersB.map((s) => s.toString()),
    },
    pairs,
    stats: {
      countNodes: counter.nodes,
      unknownsA: ma.unknownCells.length,
      unknownsB: mb.unknownCells.length,
    },
  };
}

function fixedTripleConflicts(model, data) {
  const out = [];
  for (let i = 0; i < model.C; i++) {
    for (let j = i + 1; j < model.C; j++) {
      const b11 = model.fixed1[i] & model.fixed1[j];
      const b10 = model.fixed1[i] & model.fixed0[j];
      const b01 = model.fixed0[i] & model.fixed1[j];
      if (b11 && b10 && b01) {
        out.push({
          mutA: data.mutNames[i], mutB: data.mutNames[j],
          w11: data.cellNames[lowestBitIndex(b11)],
          w10: data.cellNames[lowestBitIndex(b10)],
          w01: data.cellNames[lowestBitIndex(b01)],
        });
      }
    }
  }
  return out;
}

// 突变对关系表：按列序 (i,j)，关系取自规范补全；同时给出两份各自的细胞见证
export function buildPairTable(ma, mb, carriersA, carriersB) {
  const rows = [];
  for (let i = 0; i < ma.C; i++) {
    for (let j = i + 1; j < ma.C; j++) {
      const r = relOf(carriersA[i], carriersA[j]);
      const rB = relOf(carriersB[i], carriersB[j]);
      const nameWitness = (model, X, Y) => {
        const grab = (mask) => (mask !== 0n ? model.cellNames[lowestBitIndex(mask)] : null);
        return { w11: grab(X & Y), w10: grab(X & ~Y), w01: grab(Y & ~X) };
      };
      rows.push({
        mutA: ma.mutNames[i],
        mutB: ma.mutNames[j],
        i, j,
        rel: r,
        relLabel: REL_LABEL[r],
        relSymbol: REL_SYMBOL[r],
        consistent: r === rB,
        witnessA: nameWitness(ma, carriersA[i], carriersA[j]),
        witnessB: nameWitness(mb, carriersB[i], carriersB[j]),
      });
    }
  }
  return rows;
}
