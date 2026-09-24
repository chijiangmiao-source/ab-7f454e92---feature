// 联合复核（joint.js）专用常量
export const JOINT_LIMITS = {
  // 每份仍受原有格式限制（4–18 细胞、3–12 突变、代价规则等）；
  // 两份合计未知格不超过 20（单份问号上限在联合模式下按 20 放宽，另做合计校验）。
  maxUnknownTotal: 20,
  countNodeLimit: 2_000_000,
};
