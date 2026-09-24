// joint.js 的类型声明（联合复核核心为纯 JS）
import type { FixedConflict } from './core';

export interface JointLimits {
  maxUnknownTotal: number;
  countNodeLimit: number;
}
export const JOINT_LIMITS: JointLimits;

export type JointRelCode = 0 | 1 | 2 | 3; // 相离 / 相等 / 包含 / 被包含

export interface JointRelationWitness {
  w11: string | null;
  w10: string | null;
  w01: string | null;
}

export interface JointPairRow {
  mutA: string;
  mutB: string;
  i: number;
  j: number;
  rel: JointRelCode;
  relLabel: string;
  relSymbol: string;
  consistent: boolean;
  witnessA: JointRelationWitness;
  witnessB: JointRelationWitness;
}

export interface JointSideResult {
  R: number;
  C: number;
  cellNames: string[];
  mutNames: string[];
  assignment: number[];
  statuses: Array<'fixed0' | 'fixed1' | 'variable'>;
  completion: number[][];
  unknownCells: Array<{ r: number; c: number }>;
  carriers: string[];
}

export interface JointConflictWitness {
  side: 'A' | 'B';
  mutX: string;
  mutY: string;
  rel: string;
  cells: JointRelationWitness;
}

export interface JointConflict {
  kind: 'joint-relation' | 'joint-cross' | 'side-infeasible';
  mutA: string;
  mutB: string | null;
  side?: 'A' | 'B';
  indexA: number;
  indexB: number;
  message: string;
  witnesses: JointConflictWitness[];
}

export interface JointOptimalResult {
  status: 'optimal';
  mutNames: string[];
  optimalCost: string;
  optimalCostA: string;
  optimalCostB: string;
  optimalCount: string;
  a: JointSideResult;
  b: JointSideResult;
  pairs: JointPairRow[];
  stats: { countNodes: number; unknownsA: number; unknownsB: number };
}

export interface JointFixedConflictResult {
  status: 'fixed-conflict';
  conflictsA: FixedConflict[];
  conflictsB: FixedConflict[];
}

export interface JointConflictResult {
  status: 'joint-conflict';
  conflict: JointConflict;
}

export type JointSolveResult =
  | JointOptimalResult
  | JointFixedConflictResult
  | JointConflictResult;

export function validateJointInput(raw: unknown):
  | { ok: true; data: { a: import('./core').ValidatedData; b: import('./core').ValidatedData } }
  | { ok: false; errors: string[] };

export function solveJoint(
  data: { a: import('./core').ValidatedData; b: import('./core').ValidatedData },
  limits?: { countNodes?: number },
): JointSolveResult;
