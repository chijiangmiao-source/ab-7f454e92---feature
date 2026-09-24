// 零依赖生产静态服务器：提供构建产物与 /healthz 健康检查，端口可配置。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
]);

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(base, decoded));
  if (!target.startsWith(base)) return null;
  return target;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url === '/healthz' || url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  let filePath = safeJoin(DIST, url === '/' ? '/index.html' : url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    // SPA 回退：未知非文件路径返回 index.html；明显带扩展名的返回 404
    if (path.extname(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      data = await readFile(path.join(DIST, 'index.html'));
      filePath = path.join(DIST, 'index.html');
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('构建产物缺失，请先运行 npm run build。');
      return;
    }
  }

  const mime = MIME.get(path.extname(filePath)) ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
  res.end(data);
});

server.listen(PORT, HOST, () => {
  console.log(`完美谱系补全服务已启动: http://${HOST}:${PORT} (dist=${DIST})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
