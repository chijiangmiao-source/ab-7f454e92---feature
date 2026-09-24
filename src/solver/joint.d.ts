// joint.js 的类型声明（联合复核核心算法为纯 JS，供 TS 前端引用）

import type {
  ValidatedData,
  CellStatus,
  ProblemInput,
} from './core';

export const JOINT_LIMITS: {
  maxTotalUnknown: number;
  maxCountNodes: number;
};

export type RelSymbol = '=' | '<' | '>' | 'x' | '!';
export const REL_LABEL: Record<RelSymbol, string>;
export function relSymbol(S: bigint, T: bigint): RelSymbol;

export interface JointProblemInput {
  a: ProblemInput;
  b: ProblemInput;
}

export function validateJointInput(raw: unknown):
  | { ok: true; data: { a: ValidatedData; b: ValidatedData } }
  | { ok: false; errors: string[] };

export interface JointPairRow {
  i: number;
  j: number;
  mutA: string;
  mutB: string;
  relA: RelSymbol;
  relB: RelSymbol;
  labelA: string;
  labelB: string;
  consistent: boolean;
}

export interface JointSideResult {
  completion: number[][];
  statuses: CellStatus[];
  unknownCells: Array<{ r: number; c: number }>;
  carriers: string[];
}

export interface JointOptimalResult {
  status: 'joint-optimal';
  optimalCost: string;
  optimalCostA: string;
  optimalCostB: string;
  optimalCount: string;
  a: JointSideResult;
  b: JointSideResult;
  pairs: JointPairRow[];
  stats: { countNodes: number; unknownsA: number; unknownsB: number; unknowns: number };
}

export interface JointConflict {
  i: number;
  j: number;
  mutA: string;
  mutB: string;
  relA: RelSymbol;
  relB: RelSymbol;
  labelA: string;
  labelB: string;
}

export interface JointConflictResult {
  status: 'joint-conflict';
  message: string;
  conflict: JointConflict | null;
}

export interface JointSideInfeasibleResult {
  status: 'joint-side-infeasible';
  message: string;
  sideA: boolean;
  sideB: boolean;
}

export type JointSolveResult =
  | JointOptimalResult
  | JointConflictResult
  | JointSideInfeasibleResult;

export function solveJoint(
  validated: { a: ValidatedData; b: ValidatedData },
  limits?: { countNodes?: number },
): JointSolveResult;
