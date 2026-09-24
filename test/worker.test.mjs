// Worker 胶合层测试：在 Node 中模拟 self/postMessage，验证 worker.js 的
// 消息往返（optimal / conflict / invalid），等价于浏览器 Web Worker 的协议行为。
import test from 'node:test';
import assert from 'node:assert/strict';

function loadWorker() {
  const inbox = [];
  globalThis.self = {
    onmessage: null,
    postMessage: (msg) => inbox.push(msg),
  };
  return import(`../src/solver/worker.js?cb=${Date.now()}-${Math.random()}`).then(() => ({
    send: (payload) => self.onmessage({ data: payload }),
    drain: () => inbox.splice(0),
  }));
}

test('Worker：歧义样例返回 optimal，含任意精度计数与状态', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solve',
    payload: {
      cellNames: ['A', 'B', 'C', 'D', 'E', 'F'],
      mutNames: ['m0', 'm1', 'm2', 'm3'],
      rows: [
        ['1', '1', '0', '0'],
        ['?', '1', '0', '0'],
        ['1', '0', '1', '0'],
        ['?', '0', '1', '0'],
        ['0', '0', '0', '?'],
        ['?', '0', '0', '0'],
      ],
      costs: [
        [null, null, null, null],
        [{ c0: '9', c1: '0' }, null, null, null],
        [null, null, null, null],
        [{ c0: '9', c1: '0' }, null, null, null],
        [null, null, null, { c0: '0', c1: '0' }],
        [{ c0: '0', c1: '5' }, null, null, null],
      ],
    },
  });
  const msgs = w.drain();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'result');
  const r = msgs[0].result;
  assert.equal(r.status, 'optimal');
  assert.equal(r.optimalCost, '0');
  assert.equal(r.optimalCount, '2');
  assert.deepEqual(r.statuses, ['fixed1', 'fixed1', 'variable', 'fixed0']);
});

test('Worker：固定冲突返回 conflict 与三项见证', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solve',
    payload: {
      cellNames: ['A', 'B', 'C', 'D'],
      mutNames: ['m0', 'm1', 'm2'],
      rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '1', '?'], ['0', '0', '0']],
      costs: [[null, null, null], [null, null, null], [null, null, { c0: '0', c1: '0' }], [null, null, null]],
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.result.status, 'conflict');
  assert.equal(msg.result.conflicts[0].w11, 'A');
  assert.equal(msg.result.conflicts[0].w10, 'B');
  assert.equal(msg.result.conflicts[0].w01, 'C');
});

test('Worker：格式/规模错误返回 invalid（调用方据此保留草稿）', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solve',
    payload: {
      cellNames: ['a', 'b'],
      mutNames: ['x', 'y', 'z'],
      rows: [['0', '0', '0'], ['0', '0', '0']],
      costs: [[null, null, null], [null, null, null]],
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.result.status, 'invalid');
  assert.ok(Array.isArray(msg.result.errors) && msg.result.errors.length > 0);
});

test('Worker：非 solve 类型消息被忽略', async () => {
  const w = await loadWorker();
  w.send({ type: 'ping' });
  assert.deepEqual(w.drain(), []);
});
