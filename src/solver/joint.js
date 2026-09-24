// 联合复核求解器：同一肿瘤两次靶向测序的两份矩阵（细胞集合可以不同，
// 突变标识与顺序必须相同），在两份补全对【每一对突变】的载体关系一致
// （包含 / 被包含 / 相等 / 相离）的前提下，精确最小化两份代价之和，
// 并统计全部联合最优解、构造两份行优先 0 优先规范补全、判定每个问号在
// 联合最优中的固定性。
//
// 关键：联合优化一次性完成，不是分别调用单矩阵求解后再比较结果。
// 单矩阵求解器（solveProblem）在本文件中完全不被调用；矛盾定位只用
// “任取一份可行补全”的纯可行性提取（不优化、不比代价）作为见证。
//
// 搜索按突变（列）成对推进：联合森林的每个节点携带两个载体掩码（分属
// 两份）。候选用 core.js 的区域结构【分别】生成（每份各自层状），再按
// 对既往每个节点的关系向量配对，关系逐项一致方可成对。

import {
  validateInput,
  buildModel,
  buildFamilyStructure,
  candidates,
  makeSearch,
} from './core.js';

export const JOINT_LIMITS = {
  maxTotalUnknown: 20,
  maxCountNodes: 4_000_000,
};

const EMPTY = new Map();

/* ------------------------- 联合输入校验 ------------------------- */
// 每份仍走原有全部格式限制（validateInput 原封不动）；这里只追加跨矩阵
// 限制：突变数相同、突变标识与顺序完全一致、合计未知格 ≤ 20。
export function validateJointInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['联合复核输入必须为 JSON 对象 { a: {...}, b: {...} }。'] };
  }
  const errors = [];
  const va = validateInput(raw.a);
  const vb = validateInput(raw.b);
  if (!va.ok) for (const e of va.errors) errors.push(`矩阵一：${e}`);
  if (!vb.ok) for (const e of vb.errors) errors.push(`矩阵二：${e}`);
  if (errors.length) return { ok: false, errors };

  const a = va.data;
  const b = vb.data;
  if (a.C !== b.C) {
    errors.push(`两份矩阵的突变数必须相同：矩阵一为 ${a.C}，矩阵二为 ${b.C}。`);
  } else {
    for (let c = 0; c < a.C; c++) {
      if (a.mutNames[c] !== b.mutNames[c]) {
        errors.push(
          `第 ${c + 1} 个突变标识不一致：矩阵一为「${a.mutNames[c]}」，矩阵二为「${b.mutNames[c]}」（突变标识及顺序必须完全相同）。`,
        );
        break; // 只报首个，避免噪声
      }
    }
  }
  const totalU = a.unknownCells.length + b.unknownCells.length;
  if (totalU > JOINT_LIMITS.maxTotalUnknown) {
    errors.push(
      `两份矩阵合计未知格不得超过 ${JOINT_LIMITS.maxTotalUnknown}，当前为 ${totalU}` +
      `（矩阵一 ${a.unknownCells.length} + 矩阵二 ${b.unknownCells.length}）。`,
    );
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { a, b } };
}

/* ------------------------- 小工具 ------------------------- */

// 关系符号：'=' 相等、'<' S⊂T、'>' S⊃T、'x' 相离、'!' 交叉（非法见证）
// 注意空集：∅ 是任意集合的（严格）子集，故子集判定先于相离判定。
export function relSymbol(S, T) {
  if (S === T) return '=';
  const inter = S & T;
  if (inter === S) return '<';
  if (inter === T) return '>';
  if (inter === 0n) return 'x';
  return '!';
}

export const REL_LABEL = {
  '=': '相等（同一克隆）',
  '<': '包含于',
  '>': '包含',
  'x': '相离',
  '!': '交叉（矛盾）',
};

function keyNode(n) {
  return n[0].toString(36) + '/' + n[1].toString(36);
}
function keyForest(nodes) {
  return nodes.map(keyNode).sort().join(',');
}
function nodeEq(x, y) {
  return x[0] === y[0] && x[1] === y[1];
}
function nodeCmp(x, y) {
  if (x[0] < y[0]) return -1;
  if (x[0] > y[0]) return 1;
  if (x[1] < y[1]) return -1;
  if (x[1] > y[1]) return 1;
  return 0;
}

function colIndependentMin(model, c) {
  let s = 0n;
  for (const { uid } of model.colUnknowns[c]) {
    s += model.cost0[uid] < model.cost1[uid] ? model.cost0[uid] : model.cost1[uid];
  }
  return s;
}

function colSeededMin(model, c, inc, exc) {
  let s = 0n;
  for (const { r, uid } of model.colUnknowns[c]) {
    const bit = 1n << BigInt(r);
    if ((inc & bit) !== 0n) s += model.cost1[uid];
    else if ((exc & bit) !== 0n) s += model.cost0[uid];
    else s += model.cost0[uid] < model.cost1[uid] ? model.cost0[uid] : model.cost1[uid];
  }
  return s;
}

function colRange(model, c) {
  let lo = 0n;
  let hi = 0n;
  for (const { uid } of model.colUnknowns[c]) {
    const a = model.cost0[uid];
    const b = model.cost1[uid];
    lo += a < b ? a : b;
    hi += a > b ? a : b;
  }
  return { lo, hi };
}

/* ------------------------- 联合搜索 ------------------------- */

function makeJointSearch(modelA, modelB) {
  const C = modelA.C; // 校验已保证两份相同
  const sa = makeSearch(modelA);
  const sb = makeSearch(modelB);

  const listCache = new Map();

  // 某一份在联合森林投影下的列候选（无种子或带列种子）。
  // 投影：联合节点 -> 本份掩码，跨份同克隆时本份掩码可能重复，需去重。
  function candidatesFor(which, c, forestNodes, inc, exc) {
    const model = which === 0 ? modelA : modelB;
    const sig = which + '|' + c + '|' + keyForest(forestNodes) +
      '|' + inc.toString(36) + '|' + exc.toString(36);
    let list = listCache.get(sig);
    if (list) return list;
    const seen = new Set();
    const fam = [];
    for (const n of forestNodes) {
      const m = which === 0 ? n[0] : n[1];
      if (m === 0n) continue; // core 的层状森林只含非空载体；空集关系在联合层另行追踪
      const k = m.toString(36);
      if (!seen.has(k)) { seen.add(k); fam.push(m); }
    }
    list = candidates(model, c, buildFamilyStructure(fam), inc, exc);
    listCache.set(sig, list);
    return list;
  }

  // 候选对既有联合森林节点的关系向量（核心配对依据）。
  function relationVector(which, S, forestNodes) {
    const out = new Array(forestNodes.length);
    for (let j = 0; j < forestNodes.length; j++) {
      const m = which === 0 ? forestNodes[j][0] : forestNodes[j][1];
      out[j] = relSymbol(S, m);
    }
    return out;
  }

  // 成对候选：两份各自层状候选中，对每个既往节点关系完全一致者。
  // 空载体不做特殊配对：某一份为空、另一份非空也可以成对，只要它们对既往
  // 每个节点的关系符号逐项相同（∅ 是任意集合的子集；两份细胞集合本就不同，
  // 要求一致的只是“包含/被包含/相等/相离”关系而非载体本身）。
  function jointCandidates(c, forestNodes, incA, excA, incB, excB) {
    const la = candidatesFor(0, c, forestNodes, incA[c], excA[c]);
    const lb = candidatesFor(1, c, forestNodes, incB[c], excB[c]);
    if (!la.length || !lb.length) return [];

    const buckets = new Map();
    for (const ca of la) {
      const k = relationVector(0, ca.S, forestNodes).join(',');
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(ca);
    }

    const out = [];
    for (const cb of lb) {
      const arr = buckets.get(relationVector(1, cb.S, forestNodes).join(','));
      if (!arr) continue;
      for (const ca of arr) {
        out.push({ Sa: ca.S, Sb: cb.S, cost: ca.cost + cb.cost });
      }
    }

    const seen = new Set();
    const uniq = [];
    for (const o of out) {
      const k = o.Sa.toString(36) + '|' + o.Sb.toString(36);
      if (!seen.has(k)) { seen.add(k); uniq.push(o); }
    }
    uniq.sort((x, y) => {
      if (x.cost < y.cost) return -1;
      if (x.cost > y.cost) return 1;
      return nodeCmp([x.Sa, x.Sb], [y.Sa, y.Sb]);
    });
    return uniq;
  }

  function seedMasks(seedsA, seedsB) {
    const mA = sa.seedMasksLocal(seedsA);
    const mB = sb.seedMasksLocal(seedsB);
    return { incA: mA.inc, excA: mA.exc, incB: mB.inc, excB: mB.exc };
  }
  const zero = seedMasks([], []);

  // 推进联合森林：完全重合的节点对复用；空载体节点 [0,0] 也保留，
  // 因为“某突变在两份中同为空”仍约束它与后续突变的关系（∅⊂非空）。
  // 候选生成已保证 Sa/Sb 空性一致（空只与空配对）。
  function nextNodes(nodes, cand) {
    const node = [cand.Sa, cand.Sb];
    for (const n of nodes) if (nodeEq(n, node)) return nodes;
    return [...nodes, node].sort(nodeCmp);
  }

  /* ---- 联合最小代价（分支限界）---- */
  function minimize() {
    let upper = null;

    const greedy = (c, nodes) => {
      if (c === C) return 0n;
      const list = jointCandidates(c, nodes, zero.incA, zero.excA, zero.incB, zero.excB);
      if (!list.length) return null;
      for (const cand of list) {
        const rest = greedy(c + 1, nextNodes(nodes, cand));
        if (rest !== null) return cand.cost + rest;
      }
      return null;
    };
    const g = greedy(0, []);
    if (g === null) return null;
    upper = g;

    const suffixLB = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      suffixLB[c] = suffixLB[c + 1] + colIndependentMin(modelA, c) + colIndependentMin(modelB, c);
    }

    const dfs = (c, nodes, spent) => {
      if (spent + suffixLB[c] >= upper) return;
      if (c === C) { if (spent < upper) upper = spent; return; }
      const list = jointCandidates(c, nodes, zero.incA, zero.excA, zero.incB, zero.excB);
      for (const cand of list) {
        if (spent + cand.cost + suffixLB[c + 1] >= upper) continue;
        dfs(c + 1, nextNodes(nodes, cand), spent + cand.cost);
        if (upper === 0n) return;
      }
    };
    dfs(0, [], 0n);
    return upper;
  }

  /* ---- 联合有界可行性（可带问号种子）---- */
  function exists(seedsA, seedsB, bound) {
    const { incA, excA, incB, excB } = seedMasks(seedsA, seedsB);
    const sufLB = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      sufLB[c] = sufLB[c + 1]
        + colSeededMin(modelA, c, incA[c], excA[c])
        + colSeededMin(modelB, c, incB[c], excB[c]);
    }
    const dfs = (c, nodes, spent) => {
      if (spent > bound || spent + sufLB[c] > bound) return false;
      if (c === C) return true;
      const list = jointCandidates(c, nodes, incA, excA, incB, excB);
      for (const cand of list) {
        if (spent + cand.cost + sufLB[c + 1] > bound) break; // 已按代价升序
        if (dfs(c + 1, nextNodes(nodes, cand), spent + cand.cost)) return true;
      }
      return false;
    };
    return dfs(0, [], 0n);
  }

  /* ---- 精确计数：记忆化 (列序, 规范联合森林, 代价窗口) ---- */
  function makeCounter(limit) {
    const memo = new Map();
    let nodesVisited = 0;

    const sufMin = new Array(C + 1).fill(0n);
    const sufMax = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      const aa = colRange(modelA, c);
      const bb = colRange(modelB, c);
      sufMin[c] = sufMin[c + 1] + aa.lo + bb.lo;
      sufMax[c] = sufMax[c + 1] + aa.hi + bb.hi;
    }

    const dist = (c, fnodes, lo, hi) => {
      if (lo > hi || hi < 0n) return EMPTY;
      if (sufMin[c] > hi || sufMax[c] < lo) return EMPTY;
      if (c === C) return lo <= 0n && 0n <= hi ? new Map([[0n, 1n]]) : EMPTY;
      const sig = keyForest(fnodes);
      const key = c + '#' + sig + '#' + lo.toString() + '#' + hi.toString();
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      if (++nodesVisited > limit) throw new Error('联合计数节点数超出安全上限，未知格结构过于复杂。');

      const list = jointCandidates(c, fnodes, zero.incA, zero.excA, zero.incB, zero.excB);
      const out = new Map();
      for (const cand of list) {
        if (cand.cost > hi) continue;
        if (cand.cost + sufMin[c + 1] > hi || cand.cost + sufMax[c + 1] < lo) continue;
        const sub = dist(c + 1, nextNodes(fnodes, cand), lo - cand.cost, hi - cand.cost);
        for (const [k, v] of sub) {
          const t = k + cand.cost;
          if (t >= lo && t <= hi) out.set(t, (out.get(t) ?? 0n) + v);
        }
      }
      const result = out.size ? out : EMPTY;
      memo.set(key, result);
      return result;
    };

    return {
      countAt(target) {
        return dist(0, [], target, target).get(target) ?? 0n;
      },
      get nodes() { return nodesVisited; },
    };
  }

  /* ---- 矛盾定位：可达的最长一致前缀，及其首个关系冲突突变对 ---- */
  // 阶段一：记忆化 (列序, 联合森林) -> 从该状态能连续成对到达的最深列；
  // 阶段二：沿确定性候选序（代价、再掩码）重建一条到达该深度的规范路径，
  // 在死列用两份各自最小载体候选与前缀逐对扫描首个关系不一致对。
  function diagnoseConflict() {
    const memo = new Map();
    const maxDepth = (c, nodes) => {
      if (c === C) return C;
      const sig = c + '#' + keyForest(nodes);
      let v = memo.get(sig);
      if (v !== undefined) return v;
      const list = jointCandidates(c, nodes, zero.incA, zero.excA, zero.incB, zero.excB);
      v = c; // 无候选：停在本列
      for (const cand of list) v = Math.max(v, maxDepth(c + 1, nextNodes(nodes, cand)));
      memo.set(sig, v);
      return v;
    };

    const dead = maxDepth(0, []);
    if (dead >= C) return null;

    // 重建到 dead 列的规范前缀（picks 按列下标对齐）
    let nodes = [];
    const picks = [];
    for (let c = 0; c < dead; c++) {
      const list = jointCandidates(c, nodes, zero.incA, zero.excA, zero.incB, zero.excB);
      let chosen = null;
      for (const cand of list) {
        if (maxDepth(c + 1, nextNodes(nodes, cand)) >= dead) { chosen = cand; break; }
      }
      if (!chosen) break;
      picks.push(chosen);
      nodes = nextNodes(nodes, chosen);
    }

    const la = candidatesFor(0, dead, nodes, 0n, 0n);
    const lb = candidatesFor(1, dead, nodes, 0n, 0n);
    if (la.length && lb.length) {
      // candidates 按载体掩码升序，取最小者作为规范见证
      const Sa = la[0].S;
      const Sb = lb[0].S;
      for (let j = 0; j < dead; j++) {
        const ra = relSymbol(Sa, picks[j].Sa);
        const rb = relSymbol(Sb, picks[j].Sb);
        if (ra !== rb) {
          return {
            i: j,
            j: dead,
            mutA: modelA.mutNames[j],
            mutB: modelA.mutNames[dead],
            relA: ra,
            relB: rb,
            labelA: REL_LABEL[ra],
            labelB: REL_LABEL[rb],
          };
        }
      }
    }
    // 兜底：两份各取规范可行补全（任意可行补全都必有某个不一致对）
    const fa = anyFeasibleCarriers(modelA);
    const fb = anyFeasibleCarriers(modelB);
    if (fa && fb) return firstMismatchPair(modelA, modelB, fa, fb);
    return null;
  }

  return {
    C,
    modelA,
    modelB,
    minimize,
    exists,
    makeCounter,
    seedMasks,
    diagnoseConflict,
    materializeA: (carriers) => sa.materialize(carriers),
    materializeB: (carriers) => sb.materialize(carriers),
  };
}

/* ------------------------- 纯可行性提取（仅用于矛盾见证）------------------------- */
// 不优化代价、不计数：按载体掩码升序逐列 DFS，取一份任意可行补全的各列
// 载体集合；无任何可行补全（含固定三配型冲突）时返回 null。
function anyFeasibleCarriers(model) {
  const C = model.C;
  const dfs = (c, forest) => {
    if (c === C) return [];
    const list = candidates(model, c, buildFamilyStructure(forest), 0n, 0n);
    for (const cand of list) {
      const nf = cand.S === 0n ? forest : [...forest, cand.S];
      const rest = dfs(c + 1, nf);
      if (rest) return [cand.S, ...rest];
    }
    return null;
  };
  return dfs(0, []);
}

/* ------------------------- 主入口 ------------------------- */

export function solveJoint(validated, limits = {}) {
  const countNodeLimit = limits.countNodes ?? JOINT_LIMITS.maxCountNodes;
  const { a: dataA, b: dataB } = validated;
  const modelA = buildModel(dataA);
  const modelB = buildModel(dataB);
  // buildModel 只携带算法字段；联合层需要名称用于关系表与矛盾见证。
  modelA.mutNames = dataA.mutNames;
  modelA.cellNames = dataA.cellNames;
  modelB.mutNames = dataB.mutNames;
  modelB.cellNames = dataB.cellNames;

  const js = makeJointSearch(modelA, modelB);

  // 1) 联合最小代价（一次性联合搜索）
  const best = js.minimize();

  // 2) 联合无解：区分“某一份自身就不可解”与“两份各可解但关系矛盾”
  if (best === null) {
    const fa = anyFeasibleCarriers(modelA);
    const fb = anyFeasibleCarriers(modelB);
    if (!fa || !fb) {
      return {
        status: 'joint-side-infeasible',
        message:
          (!fa ? '矩阵一' : '') + (!fb ? '矩阵二' : '') +
          '自身就不存在满足完美谱系的补全，联合复核无法进行；请先按单矩阵求解排查。',
        sideA: !fa,
        sideB: !fb,
      };
    }
    // 两份各有可行补全，却无关系一致的组合：从“可达最长一致前缀”的首个
    // 整体死胡同定位第一个关系冲突突变对（不是分别求最优后比较）。
    const conflict = js.diagnoseConflict();
    if (!conflict) {
      return {
        status: 'joint-conflict',
        message: '两份矩阵各自可解，但不存在关系一致的联合补全。',
        conflict: null,
      };
    }
    return {
      status: 'joint-conflict',
      message:
        `两份矩阵各自可解，但不存在关系一致的联合补全。首个冲突突变对：` +
        `「${conflict.mutA} × ${conflict.mutB}」——矩阵一中为「${conflict.labelA}」，` +
        `矩阵二中为「${conflict.labelB}」。`,
      conflict,
    };
  }

  const UA = modelA.unknownCells.length;
  const UB = modelB.unknownCells.length;

  // 3) 联合规范补全：统一序（先矩阵一、后矩阵二，份内按行优先），逐格 0 优先
  const seedsA = [];
  const seedsB = [];
  const assignA = new Int8Array(UA);
  const assignB = new Int8Array(UB);
  for (let uid = 0; uid < UA; uid++) {
    if (js.exists([...seedsA, [uid, 0]], seedsB, best)) {
      assignA[uid] = 0; seedsA.push([uid, 0]);
    } else {
      assignA[uid] = 1; seedsA.push([uid, 1]);
    }
  }
  for (let uid = 0; uid < UB; uid++) {
    if (js.exists(seedsA, [...seedsB, [uid, 0]], best)) {
      assignB[uid] = 0; seedsB.push([uid, 0]);
    } else {
      assignB[uid] = 1; seedsB.push([uid, 1]);
    }
  }

  // 4) 每个问号在全部【联合最优】中的固定性
  const fixity = (seedsAA, seedsBB) => {
    const can0 = js.exists(seedsAA.z0, seedsBB.z0, best);
    const can1 = js.exists(seedsAA.z1, seedsBB.z1, best);
    return can0 && can1 ? 'variable' : can1 ? 'fixed1' : 'fixed0';
  };
  const statusesA = new Array(UA);
  for (let uid = 0; uid < UA; uid++) {
    statusesA[uid] = fixity({ z0: [[uid, 0]], z1: [[uid, 1]] }, { z0: [], z1: [] });
  }
  const statusesB = new Array(UB);
  for (let uid = 0; uid < UB; uid++) {
    statusesB[uid] = fixity({ z0: [], z1: [] }, { z0: [[uid, 0]], z1: [[uid, 1]] });
  }

  // 5) 任意精度联合最优解计数（按两份补全组成的联合解计数）
  const counter = js.makeCounter(countNodeLimit);
  const optimalCount = counter.countAt(best);

  // 6) 还原两份规范矩阵
  const carriersA = carriersFromAssignment(modelA, assignA);
  const carriersB = carriersFromAssignment(modelB, assignB);
  const completionA = js.materializeA(carriersA);
  const completionB = js.materializeB(carriersB);

  // 7) 突变对关系表（两份逐项可复核）
  const pairs = buildPairTable(modelA, carriersA, modelB, carriersB);

  return {
    status: 'joint-optimal',
    optimalCost: best.toString(),
    optimalCostA: sumCost(modelA, assignA).toString(),
    optimalCostB: sumCost(modelB, assignB).toString(),
    optimalCount: optimalCount.toString(),
    a: {
      completion: completionA.map((row) => Array.from(row)),
      statuses: statusesA,
      unknownCells: modelA.unknownCells,
      carriers: carriersA.map((s) => s.toString()),
    },
    b: {
      completion: completionB.map((row) => Array.from(row)),
      statuses: statusesB,
      unknownCells: modelB.unknownCells,
      carriers: carriersB.map((s) => s.toString()),
    },
    pairs,
    stats: { countNodes: counter.nodes, unknownsA: UA, unknownsB: UB, unknowns: UA + UB },
  };
}

function carriersFromAssignment(model, assignment) {
  const out = new Array(model.C);
  for (let c = 0; c < model.C; c++) {
    let S = model.fixed1[c];
    for (const { r, uid } of model.colUnknowns[c]) {
      if (assignment[uid] === 1) S |= 1n << BigInt(r);
    }
    out[c] = S;
  }
  return out;
}

function sumCost(model, assignment) {
  let s = 0n;
  model.unknownCells.forEach(({ r, c }, uid) => {
    const id = model.uidAt[r][c];
    s += assignment[uid] === 1 ? model.cost1[id] : model.cost0[id];
  });
  return s;
}

function buildPairTable(modelA, carriersA, modelB, carriersB) {
  const C = modelA.C;
  const rows = [];
  for (let i = 0; i < C; i++) {
    for (let j = i + 1; j < C; j++) {
      const ra = relSymbol(carriersA[i], carriersA[j]);
      const rb = relSymbol(carriersB[i], carriersB[j]);
      rows.push({
        i,
        j,
        mutA: modelA.mutNames[i],
        mutB: modelA.mutNames[j],
        relA: ra,
        relB: rb,
        labelA: REL_LABEL[ra],
        labelB: REL_LABEL[rb],
        consistent: ra === rb,
      });
    }
  }
  return rows;
}

// 首个冲突突变对：按 (i,j) 列优先序，在两份各取的规范可行补全上首次出现
// 关系符号不同的突变对。
function firstMismatchPair(modelA, modelB, carriersA, carriersB) {
  const C = modelA.C;
  for (let i = 0; i < C; i++) {
    for (let j = i + 1; j < C; j++) {
      const ra = relSymbol(carriersA[i], carriersA[j]);
      const rb = relSymbol(carriersB[i], carriersB[j]);
      if (ra !== rb) {
        return {
          i,
          j,
          mutA: modelA.mutNames[i],
          mutB: modelA.mutNames[j],
          relA: ra,
          relB: rb,
          labelA: REL_LABEL[ra],
          labelB: REL_LABEL[rb],
        };
      }
    }
  }
  // 理论上不可达（联合无解则必有不一致对）；防御性返回。
  return null;
}
