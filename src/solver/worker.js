// Web Worker：在后台线程执行输入校验与完美谱系精确求解，避免阻塞界面。
// - type:'solve'      单矩阵流程（逻辑保持不变）
// - type:'solveJoint' 联合复核流程（两份矩阵一次性联合优化，不分先后求解比较）
import { validateInput, solveProblem } from './core.js';
import { validateJointInput, solveJoint } from './joint.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || (msg.type !== 'solve' && msg.type !== 'solveJoint')) return;
  try {
    if (msg.type === 'solve') {
      const checked = validateInput(msg.payload);
      if (!checked.ok) {
        self.postMessage({ type: 'result', result: { status: 'invalid', errors: checked.errors } });
        return;
      }
      const result = solveProblem(checked.data);
      self.postMessage({ type: 'result', result });
      return;
    }
    const checked = validateJointInput(msg.payload);
    if (!checked.ok) {
      self.postMessage({ type: 'joint-result', result: { status: 'invalid', errors: checked.errors } });
      return;
    }
    const result = solveJoint(checked.data);
    self.postMessage({ type: 'joint-result', result });
  } catch (err) {
    self.postMessage({
      type: msg.type === 'solve' ? 'result' : 'joint-result',
      result: { status: 'error', errors: [String(err && err.message ? err.message : err)] },
    });
  }
};
