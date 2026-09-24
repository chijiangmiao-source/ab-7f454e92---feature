// Web Worker：在后台线程执行输入校验与完美谱系精确求解，避免阻塞界面。
// 支持两种消息：
//   - solve      ：单矩阵最小代价补全（原流程，行为保持不变）
//   - solveJoint ：两份矩阵的联合复核（关系一致前提下的联合最优）
import { validateInput, solveProblem } from './core.js';
import { validateJointInput, solveJoint } from './joint.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg.type !== 'string') return;
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
    if (msg.type === 'solveJoint') {
      const checked = validateJointInput(msg.payload);
      if (!checked.ok) {
        self.postMessage({ type: 'jointResult', result: { status: 'invalid', errors: checked.errors } });
        return;
      }
      const result = solveJoint(checked.data);
      self.postMessage({ type: 'jointResult', result });
      return;
    }
  } catch (err) {
    const payload = { status: 'error', errors: [String(err && err.message ? err.message : err)] };
    if (msg.type === 'solveJoint') self.postMessage({ type: 'jointResult', result: payload });
    else self.postMessage({ type: 'result', result: payload });
  }
};
