const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function proxyApiRequest(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: '此接口仅支持 POST 请求' });
    return;
  }

  let target;
  try {
    target = new URL(req.headers['x-api-url']);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid URL');
  } catch {
    sendJson(res, 400, { error: '请填写有效的 HTTP/HTTPS API 请求地址' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClose);
  req.on('aborted', () => controller.abort());

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: '请求内容超过 8 MB，请减少图片数量或大小' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    }

    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks),
      redirect: 'error',
      signal: controller.signal
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  } catch {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: controller.signal.aborted ? 'API 请求超时或已取消' : '无法连接 API，请检查地址、网络及服务状态；请求地址应为无需重定向的完整接口路径' });
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      sendJson(res, 400, { error: '无效请求地址' });
      return;
    }

    if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname)) {
      sendJson(res, 403, { error: '此服务仅允许本机访问' });
      return;
    }

    if (requestUrl.pathname === '/api/proxy' || requestUrl.pathname === '/api/health') {
      const origin = req.headers.origin;
      if (origin && origin !== requestUrl.origin) {
        sendJson(res, 403, { error: '请通过本地 Node 服务页面发送请求' });
        return;
      }
      if (requestUrl.pathname === '/api/health') {
        sendJson(res, 200, { service: 'idea-chat', proxy: true });
        return;
      }
      await proxyApiRequest(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: '不支持的请求方法' });
      return;
    }

    // Only publish the page and its assets; never expose repository or server files.
    let pathname;
    try { pathname = decodeURIComponent(requestUrl.pathname); }
    catch { sendJson(res, 400, { error: '无效文件路径' }); return; }
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const root = path.resolve(__dirname);
    const filePath = path.resolve(root, relativePath);
    const allowed = relativePath === 'index.html' || relativePath.startsWith('public/');
    if (!allowed || !filePath.startsWith(root + path.sep) || /[\\\0]/.test(relativePath) || relativePath.split('/').some(part => part.startsWith('.'))) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

function startServer() {
  const server = createAppServer();
  let currentPort = DEFAULT_PORT;
  function listen(port) {
    currentPort = port;
    server.listen(port, '127.0.0.1', () => {
      console.log(`Server started: http://127.0.0.1:${server.address().port}`);
    });
  }
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${currentPort} is in use, trying ${currentPort + 1}...`);
      listen(currentPort + 1);
      return;
    }
    throw err;
  });
  listen(DEFAULT_PORT);
  return server;
}

if (require.main === module) startServer();
module.exports = { createAppServer };
