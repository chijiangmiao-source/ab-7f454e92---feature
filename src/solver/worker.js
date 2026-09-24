// Web Worker：在后台线程执行输入校验与完美谱系精确求解，避免阻塞界面。
import { validateInput, solveProblem } from './core.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'solve') return;
  try {
    const checked = validateInput(msg.payload);
    if (!checked.ok) {
      self.postMessage({ type: 'result', result: { status: 'invalid', errors: checked.errors } });
      return;
    }
    const result = solveProblem(checked.data);
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({
      type: 'result',
      result: { status: 'error', errors: [String(err && err.message ? err.message : err)] },
    });
  }
};
