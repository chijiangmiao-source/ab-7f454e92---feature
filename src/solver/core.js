// 完美谱系（无限位点）最小代价补全求解器（列载体集合枚举版）
//
// 约束：任意两列（突变）在细胞行上，不得同时出现 11、10、01 三种配型。
// 等价地，各突变的载体集合构成层状族（laminar family）：任意两个载体集合
// 要么不交，要么其中一个包含另一个（相等视为同一克隆）。
//
// 搜索按列进行：依次为每个突变选择载体集合（细胞行掩码）。
// 已决定列的载体集合构成层状森林；下一列的合法载体集合必须与森林中每个集合
// 相离或成包含关系。该候选集合在固定 1/0 限制与问号种子下用行子集枚举生成。
// 未知格 ≤ 28、突变 ≤ 12、细胞 ≤ 18，候选极少，配合：
//   - 分支限界求最小代价；
//   - 带问号种子的有界可行性查询，逐格按行优先 0 优先构造规范补全并判定固定性；
//   - 对 (列序, 森林形态, 代价窗口) 记忆化的精确计数（BigInt），不枚举保存完成矩阵。

export const LIMITS = {
  minR: 4,
  maxR: 18,
  minC: 3,
  maxC: 12,
  maxUnknown: 28,
  maxCostDigits: 18,
};

/* ------------------------- 输入校验与规范化 ------------------------- */

function isIntString(v) {
  return typeof v === 'string' && /^\d+$/.test(v);
}

export function validateInput(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['输入必须为 JSON 对象。'] };
  }

  const cellNames = Array.isArray(raw.cellNames) ? raw.cellNames : null;
  const mutNames = Array.isArray(raw.mutNames) ? raw.mutNames : null;
  const rows = Array.isArray(raw.rows) ? raw.rows : null;
  const costGrid = raw.costs;

  if (!cellNames) errors.push('缺少细胞名称数组 cellNames。');
  if (!mutNames) errors.push('缺少突变名称数组 mutNames。');
  if (!rows) errors.push('缺少矩阵 rows。');
  if (errors.length) return { ok: false, errors };

  const R = cellNames.length;
  const C = mutNames.length;
  if (R < LIMITS.minR || R > LIMITS.maxR) {
    errors.push(`细胞数必须在 ${LIMITS.minR}–${LIMITS.maxR} 之间，当前为 ${R}。`);
  }
  if (C < LIMITS.minC || C > LIMITS.maxC) {
    errors.push(`唯一突变数必须在 ${LIMITS.minC}–${LIMITS.maxC} 之间，当前为 ${C}。`);
  }
  if (errors.length) return { ok: false, errors };

  const normCells = [];
  const seenC = new Set();
  for (let i = 0; i < R; i++) {
    let nm = cellNames[i];
    if (typeof nm !== 'string') nm = String(nm ?? '');
    nm = nm.trim();
    if (!nm) errors.push(`第 ${i + 1} 个细胞名称为空。`);
    else if (seenC.has(nm)) errors.push(`细胞名称重复：「${nm}」。`);
    seenC.add(nm);
    normCells.push(nm);
  }

  const normMuts = [];
  const seenM = new Set();
  for (let j = 0; j < C; j++) {
    let nm = mutNames[j];
    if (typeof nm !== 'string') nm = String(nm ?? '');
    nm = nm.trim();
    if (!nm) errors.push(`第 ${j + 1} 个突变名称为空。`);
    else if (seenM.has(nm)) errors.push(`突变名称重复：「${nm}」。`);
    seenM.add(nm);
    normMuts.push(nm);
  }

  if (!Array.isArray(costGrid) || costGrid.length !== R) {
    errors.push('代价表 costs 缺失或行数与矩阵不一致。');
  }
  if (rows.length !== R) {
    errors.push(`矩阵行数 ${rows.length} 与细胞数 ${R} 不一致。`);
  }
  for (let r = 0; r < R; r++) {
    if (!Array.isArray(rows[r]) || rows[r].length !== C) {
      errors.push(`矩阵第 ${r + 1} 行长度必须为 ${C}。`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const val = Array.from({ length: R }, () => new Int8Array(C).fill(-2));
  let unknownCount = 0;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const x = rows[r][c];
      if (x === '0' || x === 0) val[r][c] = 0;
      else if (x === '1' || x === 1) val[r][c] = 1;
      else if (x === '?' || x === null || x === undefined) val[r][c] = -1;
      else errors.push(`矩阵单元 (${normCells[r] || r + 1}, ${normMuts[c] || c + 1}) 只能是 0、1 或 ?。`);
      if (val[r][c] === -1) unknownCount++;
    }
  }
  if (unknownCount > LIMITS.maxUnknown) {
    errors.push(`未知格（?）总数不得超过 ${LIMITS.maxUnknown}，当前为 ${unknownCount}。`);
  }

  // 未知格按行优先编号
  const uidAt = Array.from({ length: R }, () => Int32Array.from({ length: C }, () => -1));
  const unknownCells = [];
  let uid = 0;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (val[r][c] === -1) {
        uidAt[r][c] = uid++;
        unknownCells.push({ r, c });
      }
    }
  }

  const cost0 = new BigInt64Array(unknownCount);
  const cost1 = new BigInt64Array(unknownCount);
  const parseCost = (v, where) => {
    let s;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) {
        errors.push(`${where}：代价必须是非负整数。`);
        return 0n;
      }
      s = String(v);
    } else if (isIntString(v)) {
      s = v;
    } else {
      errors.push(`${where}：代价必须是非负整数。`);
      return 0n;
    }
    if (s.length > LIMITS.maxCostDigits) {
      errors.push(`${where}：代价位数超出 ${LIMITS.maxCostDigits} 位。`);
      return 0n;
    }
    return BigInt(s);
  };

  for (let r = 0; r < R; r++) {
    if (!Array.isArray(costGrid[r])) continue;
    for (let c = 0; c < C; c++) {
      if (val[r][c] !== -1) continue;
      const cell = costGrid[r][c];
      const where = `问号单元 (${normCells[r] || r + 1}, ${normMuts[c] || c + 1})`;
      if (!cell || typeof cell !== 'object') {
        errors.push(`${where} 缺少代价 {c0,c1}。`);
        continue;
      }
      const id = uidAt[r][c];
      cost0[id] = parseCost(cell.c0, `${where} 填0代价`);
      cost1[id] = parseCost(cell.c1, `${where} 填1代价`);
    }
  }
  for (const { r, c } of unknownCells) {
    const id = uidAt[r][c];
    if (cost0[id] === undefined) {
      errors.push(`问号单元 (${normCells[r]}, ${normMuts[c]}) 缺少代价。`);
      cost0[id] = 0n;
      cost1[id] = 0n;
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      R,
      C,
      cellNames: normCells,
      mutNames: normMuts,
      val,
      uidAt,
      unknownCells,
      cost0,
      cost1,
    },
  };
}

/* ------------------------- 模型 ------------------------- */

// 以下内部构件同时供联合复核求解器（joint.js）复用；均为纯函数，导出不改变单矩阵流程。

export function buildModel(data) {
  const { R, C, val, uidAt, unknownCells, cost0, cost1 } = data;

  // 每列：固定 1/0 行掩码、未知格列表
  const fixed1 = Array.from({ length: C }, () => 0n);
  const fixed0 = Array.from({ length: C }, () => 0n);
  const colUnknowns = Array.from({ length: C }, () => []); // [{r, uid}]
  for (let r = 0; r < R; r++) {
    const bit = 1n << BigInt(r);
    for (let c = 0; c < C; c++) {
      if (val[r][c] === 1) fixed1[c] |= bit;
      else if (val[r][c] === 0) fixed0[c] |= bit;
      else colUnknowns[c].push({ r, uid: uidAt[r][c] });
    }
  }

  // 每列“可变行”（问号行）的固定顺序
  const colVarRows = colUnknowns.map((us) => us.map((u) => u.r));

  return { R, C, val, uidAt, unknownCells, cost0, cost1, fixed1, fixed0, colUnknowns, colVarRows };
}

function lowestBitIndex(mask) {
  let i = 0;
  while ((mask & 1n) === 0n) {
    mask >>= 1n;
    i++;
  }
  return i;
}

function popcount(x) {
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/* 固定数据直接造成的三配型冲突（与问号无关），给出突变对与三项细胞见证 */
export function findFixedConflicts(data) {
  const m = buildModel(data);
  const out = [];
  for (let i = 0; i < m.C; i++) {
    for (let j = i + 1; j < m.C; j++) {
      const b11 = m.fixed1[i] & m.fixed1[j];
      const b10 = m.fixed1[i] & m.fixed0[j];
      const b01 = m.fixed0[i] & m.fixed1[j];
      if (b11 && b10 && b01) {
        out.push({
          mutA: data.mutNames[i],
          mutB: data.mutNames[j],
          w11: data.cellNames[lowestBitIndex(b11)],
          w10: data.cellNames[lowestBitIndex(b10)],
          w01: data.cellNames[lowestBitIndex(b01)],
        });
      }
    }
  }
  return out;
}

/* ------------------------- 列载体候选 ------------------------- */

// 列 c 在种子下的基础信息：问号行掩码、全取0代价、每行“改取1”的增量
function columnCostInfo(model, c, seedInc, seedExc) {
  let varMask = 0n;
  let baseCost = 0n;
  const delta = new Map(); // r -> cost1-cost0
  for (const { r, uid } of model.colUnknowns[c]) {
    const bit = 1n << BigInt(r);
    if ((seedInc & bit) !== 0n) {
      baseCost += model.cost1[uid];
    } else {
      baseCost += model.cost0[uid]; // 含 seedExc 与自由行，先按取 0
      if ((seedExc & bit) === 0n) {
        varMask |= bit;
        delta.set(r, model.cost1[uid] - model.cost0[uid]);
      }
    }
  }
  const sumDelta = (mask) => {
    let s = 0n;
    let m = mask & varMask;
    while (m) {
      const b = m & -m;
      s += delta.get(lowestBitIndex(b));
      m ^= b;
    }
    return s;
  };
  return { varMask, baseCost, sumDelta };
}

// 由层状集合族构造一次即可复用的包含树区域结构
export function buildFamilyStructure(forest) {
  const uniq = [...new Set(forest)];
  const parent = new Map();
  for (const x of uniq) {
    let best = -1;
    let bestSize = Infinity;
    for (const y of uniq) {
      if (y !== x && (y & x) === x) {
        const sy = popcount(y);
        if (sy < bestSize) {
          bestSize = sy;
          best = y;
        }
      }
    }
    parent.set(x, best);
  }
  const realRoots = uniq.filter((x) => parent.get(x) === -1);
  const childMap = new Map();
  for (const x of uniq) {
    const p = parent.get(x);
    if (p !== -1) {
      if (!childMap.has(p)) childMap.set(p, []);
      childMap.get(p).push(x);
    }
  }
  const vChildren = new Map();
  const vFree = new Map();
  vChildren.set(-1, realRoots);
  vFree.set(-1, realRoots.length ? ~realRoots.reduce((a, b) => a | b, 0n) : ~0n);
  for (const x of uniq) {
    const kids = childMap.get(x) ?? [];
    vChildren.set(x, kids);
    vFree.set(x, kids.length ? x & ~kids.reduce((a, b) => a | b, 0n) : x);
  }
  return { uniq, vChildren, vFree, anchors: [-1, ...uniq] };
}

// 生成列 c 的所有合法载体集合（复用已缓存的集合族区域结构）：
//   - 必须包含 fixed1[c]|seedInc、排除 fixed0[c]|seedExc；
//   - 与集合族中每个集合层状相容；每个非空相容集合有唯一“附着节点”。
// 返回 [{S, cost}]，按 S 数值升序。
// 导出供联合复核求解器（joint.js）按份生成候选后跨矩阵配对。
export function candidates(model, c, struct, seedInc, seedExc) {
  const mustInc = model.fixed1[c] | seedInc;
  const mustExc = model.fixed0[c] | seedExc;
  if ((mustInc & mustExc) !== 0n) return [];

  const ci = columnCostInfo(model, c, seedInc, seedExc);

  // 该列真正自由的问号行（未被种子钉死）
  let freeRows = 0n;
  for (const r of model.colVarRows[c]) {
    const bit = 1n << BigInt(r);
    if ((mustInc & bit) === 0n && (mustExc & bit) === 0n) freeRows |= bit;
  }

  const out = [];
  const pushIf = (S) => {
    if ((S & mustInc) !== mustInc) return;
    if ((S & mustExc) !== 0n) return;
    out.push({ S, cost: ci.baseCost + ci.sumDelta(S) });
  };

  // 空载体（与所有集合相离）
  if (mustInc === 0n) out.push({ S: 0n, cost: ci.baseCost });

  // 与集合族中某个已有集合完全相等（多个突变共享同一克隆）
  for (const S of struct.uniq) pushIf(S);

  for (const v of struct.anchors) {
    const kids = struct.vChildren.get(v);
    const freeRegion = struct.vFree.get(v);

    const take = [];
    const flex = [];
    let bad = false;
    for (const w of kids) {
      const hitInc = (w & mustInc) !== 0n;
      const hitExc = (w & mustExc) !== 0n;
      if (hitInc && hitExc) {
        bad = true;
        break;
      }
      if (hitInc) take.push(w);
      else if (!hitExc) flex.push(w);
    }
    if (bad) continue;

    // 附着点自由区域中：固定/种子必含行自动纳入，必排行（含固定0）只是不选
    const regionMust = freeRegion & mustInc;
    const regionFreeRows = [];
    let rf = freeRegion & freeRows;
    while (rf) {
      const b = rf & -rf;
      regionFreeRows.push(lowestBitIndex(b));
      rf ^= b;
    }

    const baseTake = take.reduce((a, b) => a | b, 0n);
    const fk = flex.length;
    const fr = regionFreeRows.length;
    const total = 1 << (fk + fr);
    for (let mm = 0; mm < total; mm++) {
      let S = baseTake | regionMust;
      let chosenKids = take.length;
      for (let t = 0; t < fk; t++) if ((mm >> t) & 1) {
        S |= flex[t];
        chosenKids++;
      }
      let regionChosen = regionMust;
      for (let t = 0; t < fr; t++) if ((mm >> (fk + t)) & 1) {
        const b = 1n << BigInt(regionFreeRows[t]);
        S |= b;
        regionChosen |= b;
      }
      if (S === 0n) continue;
      // 恰为单个孩子且无区域部分 -> 与已有集合相等，前面已生成
      if (chosenKids === 1 && regionChosen === 0n) continue;
      // 对真实附着点 v，S 不得等于 v 本身（相等已单独生成）
      if (v !== -1 && S === v) continue;
      pushIf(S);
    }
  }

  // 保险去重并按 S 升序
  const seen = new Set();
  const uniqOut = [];
  for (const o of out) {
    const k = o.S.toString(36);
    if (!seen.has(k)) {
      seen.add(k);
      uniqOut.push(o);
    }
  }
  uniqOut.sort((a, b) => (a.S < b.S ? -1 : a.S > b.S ? 1 : 0));
  return uniqOut;
}

/* ------------------------- 搜索状态 ------------------------- */

// 种子：uid -> 0/1，转换为按列的行包含/排除掩码
function seedMasks(model, seeds) {
  const inc = new Array(model.C).fill(0n);
  const exc = new Array(model.C).fill(0n);
  for (const [uid, v] of seeds) {
    const { r, c } = model.unknownCells[uid];
    const bit = 1n << BigInt(r);
    if (v === 1) inc[c] |= bit;
    else exc[c] |= bit;
  }
  return { inc, exc };
}

export function makeSearch(model) {
  const C = model.C;
  const ZERO_INC = new Array(C).fill(0n);
  const ZERO_EXC = new Array(C).fill(0n);

  // 各列候选在给定集合族结构与种子下的缓存
  const candCache = new Map();
  const candSortedCache = new Map();
  const structCache = new Map();
  const getStruct = (familyKey, family) => {
    let s = structCache.get(familyKey);
    if (!s) {
      s = buildFamilyStructure(family);
      structCache.set(familyKey, s);
    }
    return s;
  };
  const candKey = (c, familyKey, inc, exc) =>
    c + '|' + familyKey + '|' + inc[c].toString(36) + '|' + exc[c].toString(36);
  const getCandidates = (c, familyKey, family, inc, exc) => {
    const key = candKey(c, familyKey, inc, exc);
    let list = candCache.get(key);
    if (!list) {
      list = candidates(model, c, getStruct(familyKey, family), inc[c], exc[c]);
      candCache.set(key, list);
    }
    return list;
  };
  const byCost = (a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : a.S < b.S ? -1 : a.S > b.S ? 1 : 0);
  const getCandidatesSorted = (c, familyKey, family, inc, exc) => {
    const key = candKey(c, familyKey, inc, exc);
    let list = candSortedCache.get(key);
    if (!list) {
      list = getCandidates(c, familyKey, family, inc, exc).slice().sort(byCost);
      candSortedCache.set(key, list);
    }
    return list;
  };

  /* ---- 最小代价（分支限界），返回 BigInt 或 null（无补全） ---- */
  function minimize(inc, exc) {
    let upper = null;

    const forestKey = (arr) => arr.map((s) => s.toString(36)).join(',');

    // 贪心：每列取当前代价最小的合法候选
    const greedy = (c, forest) => {
      if (c === C) return { cost: 0n, picks: [] };
      const sorted = getCandidatesSorted(c, forestKey(forest), forest, inc, exc);
      if (!sorted.length) return null;
      for (const cand of sorted) {
        const rest = greedy(c + 1, [...forest, cand.S]);
        if (rest) return { cost: cand.cost + rest.cost, picks: [cand.S, ...rest.picks] };
      }
      return null;
    };

    const g = greedy(0, []);
    if (!g) return null;
    upper = g.cost;

    // 各列最小候选代价（与森林无关的下界分量），用列自身最小未知代价求和
    const colMin = [];
    for (let c = 0; c < C; c++) {
      let lo = null;
      // 无森林时的全部合法候选下界
      for (const cand of getCandidates(c, '', [], inc, exc)) {
        if (lo === null || cand.cost < lo) lo = cand.cost;
      }
      colMin.push(lo ?? 0n);
    }
    const suffixMin = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) suffixMin[c] = suffixMin[c + 1] + colMin[c];

    const dfs = (c, forest, spent) => {
      if (spent + suffixMin[c] >= upper) return;
      if (c === C) {
        if (spent < upper) upper = spent;
        return;
      }
      const sorted = getCandidatesSorted(c, forestKey(forest), forest, inc, exc);
      for (const cand of sorted) {
        if (spent + cand.cost + suffixMin[c + 1] >= upper) continue;
        forest.push(cand.S);
        dfs(c + 1, forest, spent + cand.cost);
        forest.pop();
        if (upper === 0n) return;
      }
    };
    dfs(0, [], 0n);
    return upper;
  }

  /* ---- 有界可行性：是否存在总代价 <= bound ---- */
  function exists(inc, exc, bound) {
    const forestKey = (arr) => arr.map((s) => s.toString(36)).join(',');

    // 合法下界：每列问号在给定种子下的独立最小代价之和（忽略森林约束，仍是合法 LB）
    const suffixLB = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      let s = 0n;
      for (const { r, uid } of model.colUnknowns[c]) {
        const bit = 1n << BigInt(r);
        if ((inc[c] & bit) !== 0n) s += model.cost1[uid];
        else if ((exc[c] & bit) !== 0n) s += model.cost0[uid];
        else s += model.cost0[uid] < model.cost1[uid] ? model.cost0[uid] : model.cost1[uid];
      }
      suffixLB[c] = suffixLB[c + 1] + s;
    }

    const dfs = (c, forest, spent) => {
      if (spent > bound || spent + suffixLB[c] > bound) return false;
      if (c === C) return true;
      const sorted = getCandidatesSorted(c, forestKey(forest), forest, inc, exc);
      for (const cand of sorted) {
        if (spent + cand.cost + suffixLB[c + 1] > bound) break; // 升序，后续更贵
        forest.push(cand.S);
        if (dfs(c + 1, forest, spent + cand.cost)) {
          forest.pop();
          return true;
        }
        forest.pop();
      }
      return false;
    };
    return dfs(0, [], 0n);
  }

  /* ---- 精确计数：记忆化 (列序, 规范层状集合族, 代价窗口) ---- */
  // 未来列的合法候选只依赖“已出现的不同非空载体集合族”，
  // 与这些集合由哪些过去列产生、顺序如何、是否重复均无关（过去代价已聚合进窗口）。
  // 故键用排序去重后的非空集合掩码列表，大幅合并等价状态。
  function makeCounter(limit) {
    const memo = new Map();
    let nodes = 0;

    // 独立代价界（忽略森林）：每列问号可取代价的最小/最大之和
    const sufMin = new Array(C + 1).fill(0n);
    const sufMax = new Array(C + 1).fill(0n);
    for (let c = C - 1; c >= 0; c--) {
      let lo = 0n;
      let hi = 0n;
      for (const { uid } of model.colUnknowns[c]) {
        const a = model.cost0[uid];
        const b = model.cost1[uid];
        lo += a < b ? a : b;
        hi += a > b ? a : b;
      }
      sufMin[c] = sufMin[c + 1] + lo;
      sufMax[c] = sufMax[c + 1] + hi;
    }

    const familyKey = (family) => family.map((s) => s.toString(36)).join(',');

    const dist = (c, family, lo, hi) => {
      if (lo > hi || hi < 0n) return EMPTY;
      if (sufMin[c] > hi || sufMax[c] < lo) return EMPTY;
      if (c === C) return lo <= 0n && 0n <= hi ? ONE : EMPTY;
      const sig = familyKey(family);
      const key = c + '#' + sig + '#' + lo.toString() + '#' + hi.toString();
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      if (++nodes > limit) throw new Error('计数节点数超出安全上限，未知格结构过于复杂。');

      const list = getCandidates(c, sig, family, ZERO_INC, ZERO_EXC);
      const out = new Map();
      for (const cand of list) {
        if (cand.cost > hi) continue;
        if (cand.cost + sufMin[c + 1] > hi || cand.cost + sufMax[c + 1] < lo) continue;
        let nf = family;
        if (cand.S !== 0n && family.indexOf(cand.S) < 0) {
          nf = [...family, cand.S].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        }
        const sub = dist(c + 1, nf, lo - cand.cost, hi - cand.cost);
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
        const m = dist(0, [], target, target);
        return m.get(target) ?? 0n;
      },
      get nodes() {
        return nodes;
      },
    };
  }

  // 重建：给定每列载体集合，生成完整矩阵与问号赋值
  const materialize = (carriers) => {
    const completion = model.val.map((row) => Int8Array.from(row));
    for (let r = 0; r < model.R; r++) {
      const bit = 1n << BigInt(r);
      for (let c = 0; c < model.C; c++) {
        if (completion[r][c] === -1) completion[r][c] = (carriers[c] & bit) !== 0n ? 1 : 0;
      }
    }
    return completion;
  };

  return {
    minimize,
    exists,
    makeCounter,
    materialize,
    seedMasksLocal: (seeds) => seedMasks(model, seeds),
  };
}

const EMPTY = new Map();
const ONE = new Map([[0n, 1n]]);

/* ------------------------- 规范克隆树 ------------------------- */

export function buildCloneTree(data, completion) {
  const { R, C, cellNames, mutNames } = data;
  const carriers = new Map();
  for (let c = 0; c < C; c++) {
    let mask = 0n;
    for (let r = 0; r < R; r++) if (completion[r][c] === 1) mask |= 1n << BigInt(r);
    if (mask === 0n) continue;
    if (!carriers.has(mask)) carriers.set(mask, []);
    carriers.get(mask).push(c);
  }

  const sets = [...carriers.keys()].sort((a, b) => {
    const sa = popcount(a);
    const sb = popcount(b);
    if (sa !== sb) return sb - sa;
    return carriers.get(a)[0] - carriers.get(b)[0];
  });

  const nodes = sets.map((mask) => {
    const mutIdx = carriers.get(mask).slice().sort((a, b) => a - b);
    return {
      mask,
      firstMut: mutIdx[0],
      muts: mutIdx.map((c) => mutNames[c]),
      parent: -1,
      children: [],
      cells: [],
    };
  });

  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    let best = -1;
    let bestCount = Infinity;
    for (let t = 0; t < nodes.length; t++) {
      if (t === k) continue;
      const m = nodes[t].mask;
      if ((m & node.mask) === node.mask && m !== node.mask) {
        const cnt = popcount(m);
        if (cnt < bestCount) {
          bestCount = cnt;
          best = t;
        }
      }
    }
    node.parent = best;
    if (best >= 0) nodes[best].children.push(k);
  }

  for (let r = 0; r < R; r++) {
    const bit = 1n << BigInt(r);
    let deepest = -1;
    let deepestCount = -1;
    for (let k = 0; k < nodes.length; k++) {
      if ((nodes[k].mask & bit) !== 0n) {
        const cnt = popcount(nodes[k].mask);
        if (cnt > deepestCount) {
          deepestCount = cnt;
          deepest = k;
        }
      }
    }
    if (deepest >= 0) nodes[deepest].cells.push(cellNames[r]);
  }

  for (const node of nodes) {
    node.children.sort((a, b) => {
      const d = popcount(nodes[a].mask) - popcount(nodes[b].mask);
      if (d !== 0) return d;
      const d2 = nodes[a].firstMut - nodes[b].firstMut;
      if (d2 !== 0) return d2;
      return a - b;
    });
  }

  const roots = nodes.map((n, i) => i).filter((i) => nodes[i].parent < 0);
  const emptyMuts = [];
  for (let c = 0; c < C; c++) {
    let has = false;
    for (let r = 0; r < R; r++) if (completion[r][c] === 1) has = true;
    if (!has) emptyMuts.push(mutNames[c]);
  }
  return {
    nodes: nodes.map((n) => ({
      muts: n.muts,
      parent: n.parent,
      children: n.children,
      cells: n.cells,
      carrierCount: popcount(n.mask),
    })),
    roots,
    emptyMuts,
  };
}

/* ------------------------- 不可行诊断 ------------------------- */
// 固定数据无直接三配型，但问号任何取值都无法层状化时，给出解释性证据：
// 找到首个“无合法载体集合”的列，以及森林中两个互不相容的已决定载体集合，
// 展示该列与它们之间由固定值（及被迫取值的问号）形成的配型见证。
function infeasibilityDiagnostics(model, data) {
  const C = model.C;
  const forest = [];
  const ownerMut = []; // 每个森林集合由哪个突变下标代表

  // 贪心推进，直到某列候选为空；选择余地用“载体最少优先”以尽快暴露冲突
  for (let c = 0; c < C; c++) {
    const struct = buildFamilyStructure(forest);
    const list = candidates(model, c, struct, 0n, 0n);
    if (!list.length) {
      return explainDeadEnd(model, data, c, forest, ownerMut);
    }
    let pick = list[0];
    for (const cand of list) if (popcount(cand.S) < popcount(pick.S)) pick = cand;
    forest.push(pick.S);
    ownerMut.push(c);
  }
  return { kind: 'exhausted', message: '问号的全部取值组合均无法满足完美谱系约束。' };
}

function witnessBetween(model, data, c, a, mutA) {
  // 列 c（固定/可变）与已决定集合 a 之间三种配型的见证行
  const I = model.fixed1[c];
  const Z = model.fixed0[c];
  const grab = (mask) => (mask !== 0n ? lowestBitIndex(mask) : null);
  const describe = (r, vc) => {
    if (r == null) return null;
    const va = (a & (1n << BigInt(r))) !== 0n ? 1 : 0;
    return {
      cell: data.cellNames[r],
      values: {
        [data.mutNames[c]]: { value: vc, forced: model.val[r][c] === -1 },
        [data.mutNames[mutA]]: { value: va, forced: model.val[r][mutA] === -1 },
      },
    };
  };
  const r11 = grab(I & a);
  const r10 = grab(I & ~a);
  const r01 = grab(Z & a);
  return {
    mutA: data.mutNames[c],
    mutB: data.mutNames[mutA],
    w11: describe(r11, 1),
    w10: describe(r10, 1),
    w01: describe(r01, 0),
  };
}

function explainDeadEnd(model, data, c, forest, ownerMut) {
  const I = model.fixed1[c];
  // 与列 c 的固定载体部分 I“交叉但互不包含”的已决定集合：
  // 这些集合迫使 c 的载体 S 既要覆盖 I 中其外的行、又不能吞并它们。
  const blockers = [];
  for (let t = 0; t < forest.length; t++) {
    const A = forest[t];
    const inter = I & A;
    if (inter !== 0n && inter !== I && inter !== A) blockers.push(t);
  }
  // 其中一对互不相交的阻塞集合，使 S 不可能同时与二者层状相容
  let pair = null;
  for (let x = 0; x < blockers.length && pair === null; x++) {
    for (let y = x + 1; y < blockers.length; y++) {
      if ((forest[blockers[x]] & forest[blockers[y]]) === 0n) {
        pair = [blockers[x], blockers[y]];
        break;
      }
    }
  }

  const witnesses = [];
  if (pair) {
    for (const t of pair) witnesses.push(witnessBetween(model, data, c, forest[t], ownerMut[t]));
  } else if (blockers.length) {
    witnesses.push(witnessBetween(model, data, c, forest[blockers[0]], ownerMut[blockers[0]]));
  }

  return {
    kind: 'laminar',
    failedMut: data.mutNames[c],
    message: `突变「${data.mutNames[c]}」的任何问号取值都无法与已决定的突变载体集合构成包含或相离关系。`,
    witnesses,
  };
}

/* ------------------------- 主入口 ------------------------- */

export function solveProblem(data, limits = {}) {
  const countNodeLimit = limits.countNodes ?? 2_000_000;
  const model = buildModel(data);

  // 1) 固定数据直接三配型冲突
  const fixedConflicts = findFixedConflicts(data);
  if (fixedConflicts.length) {
    return { status: 'conflict', conflicts: fixedConflicts };
  }

  const search = makeSearch(model);
  const noSeeds = search.seedMasksLocal([]);

  // 2) 最小代价
  const best = search.minimize(noSeeds.inc, noSeeds.exc);
  if (best === null) {
    return { status: 'infeasible', diagnostics: infeasibilityDiagnostics(model, data) };
  }

  // 3) 规范补全：问号按行优先（uid 升序），逐格 0 优先裁决
  const U = model.unknownCells.length;
  const seeds = [];
  const assignment = new Int8Array(U);
  for (let uid = 0; uid < U; uid++) {
    const sm0 = search.seedMasksLocal([...seeds, [uid, 0]]);
    if (search.exists(sm0.inc, sm0.exc, best)) {
      assignment[uid] = 0;
      seeds.push([uid, 0]);
    } else {
      assignment[uid] = 1;
      seeds.push([uid, 1]);
    }
  }

  // 4) 每个问号在全部最优补全中的固定性
  const statuses = new Array(U);
  for (let uid = 0; uid < U; uid++) {
    const s0 = search.seedMasksLocal([[uid, 0]]);
    const s1 = search.seedMasksLocal([[uid, 1]]);
    const can0 = search.exists(s0.inc, s0.exc, best);
    const can1 = search.exists(s1.inc, s1.exc, best);
    statuses[uid] = can0 && can1 ? 'variable' : can1 ? 'fixed1' : 'fixed0';
  }

  // 5) 任意精度最优补全数
  const counter = search.makeCounter(countNodeLimit);
  const optimalCount = counter.countAt(best);

  // 6) 还原规范矩阵：按规范赋值直接生成每列载体集合
  const carriers = new Array(model.C);
  for (let c = 0; c < model.C; c++) {
    let S = model.fixed1[c];
    for (const { r, uid } of model.colUnknowns[c]) {
      if (assignment[uid] === 1) S |= 1n << BigInt(r);
    }
    carriers[c] = S;
  }
  const completion = search.materialize(carriers);

  // 7) 规范克隆树
  const tree = buildCloneTree(data, completion);

  return {
    status: 'optimal',
    optimalCost: best.toString(),
    optimalCount: optimalCount.toString(),
    assignment: Array.from(assignment),
    statuses,
    completion: completion.map((row) => Array.from(row)),
    unknownCells: model.unknownCells,
    carriers: carriers.map((s) => s.toString()),
    tree,
    stats: { countNodes: counter.nodes, unknowns: U },
  };
}
