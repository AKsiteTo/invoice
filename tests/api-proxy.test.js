const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createAppServer } = require('../server.js');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fixture(t, upstreamHandler) {
  const upstream = http.createServer(upstreamHandler || ((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  }));
  const app = createAppServer();
  const upstreamUrl = await listen(upstream);
  const appUrl = await listen(app);
  t.after(() => Promise.all([close(app), close(upstream)]));
  return { appUrl, upstreamUrl };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function proxyRequest(appUrl, upstreamUrl, overrides = {}) {
  return fetch(`${appUrl}/api/proxy`, {
    method: 'POST',
    headers: {
      'X-API-URL': upstreamUrl,
      Authorization: 'Bearer test-key-do-not-use',
      'Content-Type': 'application/json',
      ...overrides.headers
    },
    body: overrides.body ?? '{"model":"gpt-image-2.5-flare","prompt":"生成测试图片","n":1}'
  });
}

test('health identifies the local app proxy', async t => {
  const { appUrl } = await fixture(t);
  const response = await fetch(`${appUrl}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.service, 'idea-chat');
  assert.equal(data.proxy, true);
});

test('same-origin proxy succeeds when the upstream rejects browser preflight', async t => {
  let received;
  const { appUrl, upstreamUrl } = await fixture(t, async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readBody(req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      res.writeHead(400);
      res.end('{"error":{"message":"unsupported endpoint: this image model does not support chat completions"}}');
      return;
    }
    const data = JSON.parse(body);
    if (req.url !== '/v1/images/generations' || typeof data.model !== 'string' || !data.model ||
        typeof data.prompt !== 'string' || !data.prompt || data.n !== 1 || Object.hasOwn(data, 'messages')) {
      res.writeHead(400);
      res.end('{"error":{"message":"Images API requires model, prompt and n; messages is unsupported"}}');
      return;
    }
    received = { method: req.method, url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[{"url":"https://example.invalid/mock-image.png"}]}');
  });

  const preflight = await fetch(`${upstreamUrl}/v1/images/generations`, {
    method: 'OPTIONS',
    headers: {
      Origin: appUrl,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const unsupported = await proxyRequest(appUrl, `${upstreamUrl}/v1/chat/completions`, {
    headers: { Origin: appUrl },
    body: '{"model":"gpt-image-2.5-flare","messages":[{"role":"user","content":"生成测试图片"}]}'
  });
  assert.equal(unsupported.status, 400);
  assert.match(await unsupported.text(), /unsupported endpoint/);

  const body = JSON.stringify({
    model: 'gpt-image-2.5-flare',
    prompt: '生成测试图片',
    n: 1
  });
  const response = await proxyRequest(appUrl, `${upstreamUrl}/v1/images/generations`, {
    headers: { Origin: appUrl }, body
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mock-image\.png/);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/images/generations');
  assert.equal(received.headers.authorization, 'Bearer test-key-do-not-use');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['x-api-url'], undefined);
  assert.equal(received.body, body);
});

test('image edits JSON preserves images[].image_url and n through the proxy', async t => {
  let received;
  const { appUrl, upstreamUrl } = await fixture(t, async (req, res) => {
    const body = await readBody(req);
    const data = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/v1/images/edits' || typeof data.model !== 'string' || !data.model ||
        typeof data.prompt !== 'string' || !data.prompt || data.n !== 1 || Object.hasOwn(data, 'messages') ||
        !Array.isArray(data.images) || data.images.length === 0 ||
        data.images.some(image => typeof image.image_url !== 'string' || !image.image_url)) {
      res.writeHead(400);
      res.end('{"error":{"message":"Images edits requires model, prompt, n and images[].image_url"}}');
      return;
    }
    received = { method: req.method, headers: req.headers, body };
    res.writeHead(200);
    res.end('{"data":[{"url":"https://example.invalid/mock-edited-image.png"}]}');
  });

  const body = JSON.stringify({
    model: 'gpt-image-2.5-sunburst',
    prompt: '把图片背景改为蓝色',
    n: 1,
    images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }]
  });
  const response = await proxyRequest(appUrl, `${upstreamUrl}/v1/images/edits`, {
    headers: { Origin: appUrl }, body
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mock-edited-image\.png/);
  assert.equal(received.method, 'POST');
  assert.equal(received.headers.authorization, 'Bearer test-key-do-not-use');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['x-api-url'], undefined);
  assert.equal(received.body, body);
});

for (const status of [401, 403]) {
  test(`upstream ${status} status and error body reach the client`, async t => {
    const errorBody = JSON.stringify({ error: { message: `upstream rejected ${status}` } });
    const { appUrl, upstreamUrl } = await fixture(t, async (req, res) => {
      await readBody(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(errorBody);
    });
    const response = await proxyRequest(appUrl, upstreamUrl);
    assert.equal(response.status, status);
    assert.equal(await response.text(), errorBody);
  });
}

test('invalid target URL is rejected before reaching the upstream', async t => {
  let upstreamCalls = 0;
  const { appUrl } = await fixture(t, (_req, res) => {
    upstreamCalls++;
    res.end();
  });
  for (const invalidUrl of ['not-a-url', 'file:///C:/Windows/win.ini', 'ftp://example.com/data']) {
    const response = await proxyRequest(appUrl, invalidUrl);
    assert.equal(response.status, 400, invalidUrl);
    await response.text();
  }
  assert.equal(upstreamCalls, 0);
});

test('proxy accepts POST only', async t => {
  const { appUrl } = await fixture(t);
  const response = await fetch(`${appUrl}/api/proxy`);
  assert.equal(response.status, 405);
  await response.text();
});

test('foreign browser origin cannot use the proxy', async t => {
  let upstreamCalls = 0;
  const { appUrl, upstreamUrl } = await fixture(t, (_req, res) => {
    upstreamCalls++;
    res.end();
  });
  const response = await proxyRequest(appUrl, upstreamUrl, {
    headers: { Origin: 'http://evil.example' }
  });
  assert.equal(response.status, 403);
  await response.text();
  assert.equal(upstreamCalls, 0);
});

test('upstream redirects are not followed with an API key', async t => {
  let redirectedCalls = 0;
  const { appUrl, upstreamUrl } = await fixture(t, async (req, res) => {
    await readBody(req);
    if (req.url === '/redirect-target') {
      redirectedCalls++;
      res.end('unexpected redirect');
      return;
    }
    res.writeHead(307, { Location: `${upstreamUrl}/redirect-target` });
    res.end();
  });
  const response = await proxyRequest(appUrl, `${upstreamUrl}/redirect`);
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(redirectedCalls, 0);
});

test('payload above 8 MiB is rejected before forwarding', async t => {
  let upstreamCalls = 0;
  const { appUrl, upstreamUrl } = await fixture(t, async (req, res) => {
    upstreamCalls++;
    await readBody(req);
    res.end();
  });
  const response = await proxyRequest(appUrl, upstreamUrl, {
    body: 'x'.repeat(8 * 1024 * 1024 + 1)
  });
  assert.equal(response.status, 413);
  await response.text();
  assert.equal(upstreamCalls, 0);
});

test('index and query-string URLs serve the page, private files stay inaccessible', async t => {
  const { appUrl } = await fixture(t);
  for (const pathname of ['/', '/index.html?test=1']) {
    const response = await fetch(`${appUrl}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Idea Chat/);
  }
  const gitResponse = await fetch(`${appUrl}/.git/config`);
  assert.equal(gitResponse.status, 404);
  await gitResponse.text();
  const traversal = await fetch(`${appUrl}/%2e%2e%2fAGENTS.md`);
  assert.ok([403, 404].includes(traversal.status));
  await traversal.text();
});
