// 出海热点雷达 · 服务入口:静态托管 + API 路由 + SSE
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_VERSION, HOST, PORT, PUBLIC_DIR } from './server/config.js';
import { handle } from './server/routes.js';
import { boot } from './server/scheduler.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel.slice(1)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  // 本地开发:html/css/js 一律 no-cache,改代码刷新即生效
  const cacheable = !['.html', '.css', '.js'].includes(ext);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': cacheable ? 'public, max-age=300' : 'no-cache',
  });
  res.end(readFileSync(file));
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      handle(req, res, url).catch((e) => {
        console.error('[server] 路由异常:', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '服务器内部错误' }));
        } else {
          res.end();
        }
      });
    } else if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    console.error('[server] 请求异常:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被占用。可执行 lsof -i :${PORT} 查看占用进程,或用 PORT=其他端口 npm start\n`);
  } else {
    console.error('[server] 启动失败:', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${APP_NAME} v${APP_VERSION}`);
  console.log(`  http://${HOST}:${PORT}  (局域网访问:HOST=0.0.0.0 npm start)`);
  console.log(`${'='.repeat(52)}\n`);
  boot();
});
