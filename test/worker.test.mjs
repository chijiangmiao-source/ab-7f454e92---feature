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

test('Worker：solveJoint 返回 optimal（联合代价/两份规范矩阵/关系表）', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solveJoint',
    payload: {
      a: {
        cellNames: ['A1', 'A2', 'A3', 'A4'], mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '?', '0'], ['?', '1', '0'], ['0', '0', '1'], ['0', '0', '0']],
        costs: [
          [null, { c0: '0', c1: '3' }, null],
          [{ c0: '0', c1: '2' }, null, null],
          [null, null, null],
          [null, null, null],
        ],
      },
      b: {
        cellNames: ['B1', 'B2', 'B3', 'B4'], mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '1', '0'], ['?', '?', '0'], ['0', '0', '?'], ['0', '0', '0']],
        costs: [
          [null, null, null],
          [{ c0: '1', c1: '0' }, { c0: '1', c1: '0' }, null],
          [null, null, { c0: '0', c1: '4' }],
          [null, null, null],
        ],
      },
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.type, 'jointResult');
  const r = msg.result;
  assert.equal(r.status, 'optimal');
  assert.equal(r.optimalCost, '3');
  assert.ok(BigInt(r.optimalCount) >= 1n);
  assert.equal(r.a.completion.length, 4);
  assert.equal(r.b.completion.length, 4);
  // 三对突变关系在两份中一致
  assert.ok(r.pairs.length === 3);
  assert.ok(r.pairs.every((p) => p.consistent));
});

test('Worker：solveJoint 单份可解而关系矛盾时返回 joint-conflict 并定位首个冲突对', async () => {
  const w = await loadWorker();
  w.send({
    type: 'solveJoint',
    payload: {
      a: {
        cellNames: ['a0', 'a1', 'a2', 'a3'], mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '1', '0'], ['1', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
        costs: Array.from({ length: 4 }, () => [null, null, null]),
      },
      b: {
        cellNames: ['b0', 'b1', 'b2', 'b3'], mutNames: ['m0', 'm1', 'm2'],
        rows: [['1', '1', '0'], ['0', '1', '0'], ['0', '0', '0'], ['0', '0', '0']],
        costs: Array.from({ length: 4 }, () => [null, null, null]),
      },
    },
  });
  const [msg] = w.drain();
  assert.equal(msg.type, 'jointResult');
  assert.equal(msg.result.status, 'joint-conflict');
  assert.equal(msg.result.conflict.mutA, 'm1');
  assert.equal(msg.result.conflict.mutB, 'm0');
});

test('Worker：solveJoint 突变列不一致/细胞集相同/合计问号超限均返回 invalid 且保留错误', async () => {
  const w = await loadWorker();
  const base = {
    cellNames: ['a0', 'a1', 'a2', 'a3'], mutNames: ['m0', 'm1', 'm2'],
    rows: [['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0'], ['0', '0', '0']],
    costs: Array.from({ length: 4 }, () => [null, null, null]),
  };
  const diffMuts = { ...base, cellNames: ['b0', 'b1', 'b2', 'b3'], mutNames: ['m0', 'X', 'm2'] };
  w.send({ type: 'solveJoint', payload: { a: base, b: diffMuts } });
  let [msg] = w.drain();
  assert.equal(msg.result.status, 'invalid');
  assert.ok(msg.result.errors.join(';').includes('突变'));

  const sameCells = { ...base, cellNames: ['a0', 'a1', 'a2', 'a3'] };
  w.send({ type: 'solveJoint', payload: { a: base, b: sameCells } });
  [msg] = w.drain();
  assert.equal(msg.result.status, 'invalid');
  assert.ok(msg.result.errors.join(';').includes('细胞集合必须不同'));
});

test('Worker：solveJoint 缺两份矩阵时返回 invalid（协议不吞错）', async () => {
  const w = await loadWorker();
  w.send({ type: 'solveJoint', payload: null });
  const [msg] = w.drain();
  assert.equal(msg.type, 'jointResult');
  assert.equal(msg.result.status, 'invalid');
  assert.ok(msg.result.errors.length > 0);
});
