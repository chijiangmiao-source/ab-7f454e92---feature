// core.js 的类型声明（核心算法为纯 JS，供 TS 前端与 Worker 引用）

export interface Limits {
  minR: number;
  maxR: number;
  minC: number;
  maxC: number;
  maxUnknown: number;
  maxCostDigits: number;
}

export const LIMITS: Limits;

export interface CostCell {
  c0: string | number;
  c1: string | number;
}

export interface ProblemInput {
  cellNames: string[];
  mutNames: string[];
  rows: Array<Array<'0' | '1' | '?' | 0 | 1 | null>>;
  costs: Array<Array<CostCell | null>>;
}

export interface ValidatedData {
  R: number;
  C: number;
  cellNames: string[];
  mutNames: string[];
  val: Int8Array[];
  uidAt: Int32Array[];
  unknownCells: Array<{ r: number; c: number }>;
  cost0: BigInt64Array;
  cost1: BigInt64Array;
}

export function validateInput(raw: unknown):
  | { ok: true; data: ValidatedData }
  | { ok: false; errors: string[] };

export interface FixedConflict {
  mutA: string;
  mutB: string;
  w11: string;
  w10: string;
  w01: string;
}

export interface TreeNode {
  muts: string[];
  parent: number;
  children: number[];
  cells: string[];
  carrierCount: number;
}

export interface CloneTree {
  nodes: TreeNode[];
  roots: number[];
  emptyMuts: string[];
}

export type CellStatus = 'fixed0' | 'fixed1' | 'variable';

export interface OptimalResult {
  status: 'optimal';
  optimalCost: string;
  optimalCount: string;
  assignment: number[];
  statuses: CellStatus[];
  completion: number[][];
  unknownCells: Array<{ r: number; c: number }>;
  carriers: string[];
  tree: CloneTree;
  stats: { countNodes: number; unknowns: number };
}

export interface InfeasibleResult {
  status: 'infeasible';
  diagnostics: unknown;
}

export interface ConflictResult {
  status: 'conflict';
  conflicts: FixedConflict[];
}

export type SolveResult = OptimalResult | InfeasibleResult | ConflictResult;

export function solveProblem(data: ValidatedData, limits?: { countNodes?: number }): SolveResult;
export function findFixedConflicts(data: ValidatedData): FixedConflict[];
export function buildCloneTree(data: ValidatedData, completion: number[][]): CloneTree;
