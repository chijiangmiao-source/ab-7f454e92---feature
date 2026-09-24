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

/* ----------------------------- 联合复核协议 ----------------------------- */

test('Worker：solveJoint 返回 joint-optimal（联合计数与两份状态）', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solveJoint',
    payload: {
      a: {
        cellNames: ['A', 'B', 'C', 'D'],
        mutNames: ['m0', 'm1', 'm2'],
        rows: [['?', '1', '0'], ['?', '0', '0'], ['0', '0', '1'], ['0', '0', '0']],
        costs: [
          [{ c0: '0', c1: '0' }, null, null],
          [{ c0: '0', c1: '0' }, null, null],
          [null, null, null], [null, null, null],
        ],
      },
      b: {
        cellNames: ['X', 'Y', 'Z', 'W'],
        mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '1', '0'], ['0', '0', '0'], ['0', '0', '1'], ['0', '0', '0']],
        costs: [
          [null, null, null], [null, null, null], [null, null, null], [null, null, null],
        ],
      },
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.type, 'joint-result');
  assert.equal(msg.result.status, 'joint-optimal');
  assert.equal(msg.result.optimalCount, '1');
  assert.deepEqual(msg.result.a.statuses, ['fixed1', 'fixed0']);
  // 关系表每份符号一致
  for (const p of msg.result.pairs) assert.equal(p.relA, p.relB);
});

test('Worker：solveJoint 关系矛盾返回 joint-conflict 并定位首个冲突对', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solveJoint',
    payload: {
      a: {
        cellNames: ['A', 'B', 'C', 'D'],
        mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '0', '0'], ['1', '0', '0'], ['0', '1', '0'], ['0', '0', '1']],
        costs: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]],
      },
      b: {
        cellNames: ['X', 'Y', 'Z', 'W', 'V'],
        mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '1', '0'], ['1', '1', '0'], ['1', '0', '0'], ['0', '0', '1'], ['0', '0', '0']],
        costs: Array.from({ length: 5 }, () => [null, null, null]),
      },
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.type, 'joint-result');
  assert.equal(msg.result.status, 'joint-conflict');
  assert.equal(msg.result.conflict.mutA, 'm0');
  assert.equal(msg.result.conflict.mutB, 'm1');
});

test('Worker：solveJoint 校验失败返回 invalid（合计问号超 20）', async () => {
  const w = await loadWorker();
  const mk = (R, U) => ({
    cellNames: Array.from({ length: R }, (_, i) => `c${i}`),
    mutNames: ['x', 'y', 'z'],
    rows: Array.from({ length: R }, (_, r) => (r < U ? ['?', '?', '?'] : ['0', '0', '0'])),
    costs: Array.from({ length: R }, (_, r) =>
      (r < U ? [{ c0: '0', c1: '0' }, { c0: '0', c1: '0' }, { c0: '0', c1: '0' }] : [null, null, null])),
  });
  w.send({ type: 'solveJoint', payload: { a: mk(7, 7), b: mk(7, 0) } }); // 21 个问号
  const [msg] = w.drain();
  assert.equal(msg.type, 'joint-result');
  assert.equal(msg.result.status, 'invalid');
  assert.ok(msg.result.errors.join(';').includes('合计未知格不得超过 20'));
});
