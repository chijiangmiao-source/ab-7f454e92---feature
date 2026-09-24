# 完美谱系最小代价补全（单细胞靶向测序）

在浏览器中录入 4–18 个细胞、3–12 个唯一突变的 `0 / 1 / ?` 矩阵，并为每个问号
设置「填 0 / 填 1」的非负整数代价（未知格总数 ≤ 28）。Web Worker 在浏览器内
**精确**寻找满足无限位点完美谱系（任意两列不得同时出现 `11、10、01` 三种配型）
的补全，并最小化补值总代价。

## 结果

- **最优补总代价**（任意精度大整数）；
- **最优补全数**（BigInt 精确计数，不枚举、不保存全部完成矩阵）；
- **行优先、0 优先裁决的规范补全矩阵**，每个问号标注：
  - 固定 0（所有最优补全中都取 0）
  - 固定 1（所有最优补全中都取 1）
  - 同优可变（取 0、取 1 都能达到最优代价）
- **由突变载体包含关系生成的规范克隆树**（层状族 / laminar family）；
- 固定数据本身已形成三配型冲突时，展示涉及的突变对与 `11/10/01` 三项细胞见证；
- 无固定冲突但任何补全皆矛盾时，给出不可行诊断；
- 格式或规模错误时**保留草稿**，旧结果以「陈旧结果」警示保留，绝不冒充当前结论。

## 本地开发

```bash
npm install
npm run dev        # Vite 开发服务器（http://localhost:5173）
npm run typecheck  # 仅类型检查
npm run test:solver
npm run build      # tsc + vite build -> dist/
npm run serve      # 零依赖生产静态服务器（PORT 可覆盖）
```

## Compose（可配置宿主机端口）

```bash
# 使用默认 8080
docker compose up -d --build web

# 自定义宿主机端口
HOST_PORT=9090 docker compose up -d --build web
# 或复制 .env.example 为 .env 后修改 HOST_PORT
```

- 页面：`http://localhost:${HOST_PORT}/`
- 健康路径：`http://localhost:${HOST_PORT}/healthz` → `{"status":"ok"}`

## 单次 verify 服务

`verify` 服务一次性执行：求解器测试（含穷举对拍）→ 生产构建 → 固定歧义/冲突样例
核对（计数、规范补全、克隆树、三项见证）→ 对运行中的 web 服务做 HTTP 冒烟；
全部通过以退出码 `0` 结束。

```bash
# 先启动并等待 web 健康，再运行一次性 verify（其退出码即结果）
docker compose --profile verify up --build \
  --abort-on-container-exit --exit-code-from verify
# 或本地（无需 Docker）：
npm run verify
```

## 求解方法（要点）

- 完美谱系约束等价于：各突变载体集合构成**层状族**——任意两个集合要么不交，
  要么成包含关系（相等即同一克隆）。
- 按列枚举载体集合：已决定列构成层状森林，下一列合法集合必为森林某区域的并；
  用包含树区域结构直接生成候选，而非枚举全部行子集。
- 分支限界求最小代价；带问号种子的有界可行性查询用于逐格（行优先、0 优先）
  构造规范补全，并判定每个问号在全部最优解中的固定性。
- 计数对 `(列序, 规范集合族, 代价窗口)` 记忆化（BigInt 稀疏分布），
  天然按「不同载体集合」合并对称状态，不枚举保存完成矩阵。

## 目录

```
src/solver/core.js     纯 ESM 求解器（浏览器 Worker 与 Node 测试共用）
src/solver/worker.js   Web Worker 胶合层
src/ui/                页面（TS）与样式
server/main.mjs        零依赖生产静态服务器 + /healthz
test/                  node:test 求解器与 Worker 协议测试
scripts/verify.mjs     单次 verify 编排
Dockerfile, docker-compose.yml
```
