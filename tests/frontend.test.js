const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Load the actual frontend functions without starting IndexedDB or the page UI.
const source = inlineScript.replace(/\ninit\(\);\s*updateUI\(\);\s*$/, '\n');
assert.notEqual(source, inlineScript, 'The page initialization calls must be excluded');
const compiledScript = new vm.Script(source, { filename: 'index.html' });
const models = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const apiUrl = 'https://e0b00642f591.nofx.one/v1/images/generations';
const editApiUrl = 'https://e0b00642f591.nofx.one/v1/images/edits';
const fixtureAuth = 'Bearer test-key-do-not-use';

function frontend(fetchImpl) {
  const nodes = new Map();
  const storage = new Map();
  const context = vm.createContext({
    console, URL, Headers, Blob, TextEncoder, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { location: { protocol: 'http:' } },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) {
          nodes.set(id, {
            value: '', textContent: '', innerHTML: '', style: {},
            addEventListener() {}, appendChild() {}
          });
        }
        return nodes.get(id);
      },
      createElement() { return {}; }
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); }
    },
    fetch: fetchImpl || (async () => { throw new Error('Unexpected fetch'); }),
    alert(message) { throw new Error(message); }
  });
  compiledScript.runInContext(context);
  // Image persistence/rendering is outside these request and settings tests.
  vm.runInContext(`
    convertImagesInContent = async value => value;
    convertRawDataUrlsInContent = async value => value;
    resolveContentImages = async value => value;
    state.abortController = new AbortController();
    state.settings.apiKey = 'test-key-do-not-use';
    normalizeApiSettings();
  `, context);
  return { context, nodes, storage, evaluate: code => vm.runInContext(code, context) };
}

function healthResponse(data = { service: 'idea-chat', proxy: true }, status = 200) {
  return { ok: status === 200, status, json: async () => data };
}

function completionResponse() {
  return { ok: true, json: async () => ({ output_text: 'mock result' }) };
}

test('model options, saved selection, restored settings and badge agree for both models', async () => {
  const select = html.match(/<select id="modelName">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), models);
  const app = frontend();
  assert.equal(app.evaluate('getCurrentModel()'), 'gpt-image-2.5-flare');
  for (const model of models) {
    app.context.openSettings();
    app.nodes.get('modelName').value = model;
    app.context.saveSettings();
    assert.equal(app.nodes.get('modelBadge').textContent, model);
    assert.equal(JSON.parse(app.storage.get('ai_chat_data')).settings.model, model);
    app.evaluate("state.settings.model = 'gpt-image-2';");
    await app.context.loadFromStorage();
    app.context.updateUI();
    app.context.openSettings();
    assert.equal(app.nodes.get('modelBadge').textContent, model);
    assert.equal(app.nodes.get('modelName').value, model);
  }
  app.storage.set('ai_chat_data', JSON.stringify({ settings: { model: 'gpt-image-2' } }));
  await app.context.loadFromStorage();
  assert.equal(app.evaluate('getCurrentModel()'), 'gpt-image-2.5-flare');
});

test('settings expose Key and model controls without URL or profile inputs', () => {
  assert.equal(/<input[^>]*id="apiKey"[^>]*type="password"|<input[^>]*type="password"[^>]*id="apiKey"/.test(html), true);
  assert.equal(/id="(?:apiBaseUrl|apiProfileSelect|apiProfileName)"/.test(html), false, 'Legacy API URL and profile controls must be removed');
  assert.equal(/(?:switchApiProfileForm|addApiProfileForm|deleteApiProfileForm)\(/.test(html), false, 'Legacy profile handlers must be removed');
});

test('image endpoint selection uses the fixed generation and edit URLs', () => {
  const app = frontend();
  assert.equal(app.context.getImageApiUrl(false), apiUrl);
  assert.equal(app.context.getImageApiUrl(true), editApiUrl);
});

test('the active legacy profile Key migrates while legacy URLs and profile settings are removed', async () => {
  const app = frontend();
  app.storage.set('ai_chat_data', JSON.stringify({ settings: {
    apiKey: 'legacy-current-test-key',
    apiBaseUrl: 'https://untrusted.example/v1/chat/completions',
    apiUrl: 'https://untrusted.example/v1/images/generations',
    apiProfiles: [
      { id: 'first', apiUrl: 'https://untrusted.example/first', apiKey: 'first-test-key' },
      { id: 'active', apiUrl: 'https://untrusted.example/active', apiKey: 'active-test-key' }
    ],
    activeApiProfileId: 'active'
  } }));
  await app.context.loadFromStorage();
  assert.equal(app.context.getCurrentApiKey(), 'active-test-key');
  for (const field of ['apiProfiles', 'activeApiProfileId', 'apiBaseUrl', 'apiUrl']) {
    assert.equal(app.evaluate('Object.hasOwn(state.settings, ' + JSON.stringify(field) + ')'), false);
  }
  const generation = await app.context.buildImageRequest([{ role: 'user', content: 'fixture prompt' }]);
  const edit = await app.context.buildImageRequest([{ role: 'user', content: [
    { type: 'text', text: 'edit fixture' },
    { type: 'image_url', image_url: { url: 'https://images.example/input.png' } }
  ] }]);
  assert.equal(generation.url, apiUrl);
  assert.equal(edit.url, editApiUrl);
  app.context.saveToStorage();
  const saved = JSON.parse(app.storage.get('ai_chat_data')).settings;
  assert.equal(saved.apiKey, 'active-test-key');
  assert.equal(Object.hasOwn(saved, 'apiProfiles'), false);
  assert.equal(Object.hasOwn(saved, 'activeApiProfileId'), false);
  assert.equal(Object.hasOwn(saved, 'apiBaseUrl'), false);
  assert.equal(Object.hasOwn(saved, 'apiUrl'), false);
});

test('a missing legacy active profile preserves the existing Key and ignores legacy URLs', async () => {
  const app = frontend();
  app.storage.set('ai_chat_data', JSON.stringify({ settings: {
    apiKey: '  existing-test-key  ',
    apiBaseUrl: 'https://untrusted.example/api',
    apiProfiles: [{ id: 'unused', apiKey: 'unused-test-key' }],
    activeApiProfileId: 'missing'
  } }));
  await app.context.loadFromStorage();
  assert.equal(app.context.getCurrentApiKey(), 'existing-test-key');
  assert.equal(app.context.getImageApiUrl(false), apiUrl);
  assert.equal(app.context.getImageApiUrl(true), editApiUrl);
});

test('Key-only settings save and reload preserve the entered Key', async () => {
  const app = frontend();
  app.context.openSettings();
  app.nodes.get('apiKey').value = '  updated-test-key  ';
  app.context.saveSettings();
  assert.equal(app.context.getCurrentApiKey(), 'updated-test-key');
  assert.equal(JSON.parse(app.storage.get('ai_chat_data')).settings.apiKey, 'updated-test-key');
  app.evaluate("state.settings.apiKey = '';");
  await app.context.loadFromStorage();
  app.context.openSettings();
  assert.equal(app.nodes.get('apiKey').value, 'updated-test-key');
});

test('recognized local health routes all selected models through the proxy with target, auth and body', async () => {
  const requests = [];
  const app = frontend(async (url, options) => {
    requests.push({ url, options });
    return url === '/api/health' ? healthResponse() : completionResponse();
  });
  const messages = [{ role: 'user', content: 'fixture prompt' }];
  for (const model of models) {
    app.evaluate(`state.settings.model = ${JSON.stringify(model)};`);
    const assistant = { id: 'fixture' };
    await app.context.requestImageGeneration(messages, assistant);
    const request = requests.at(-1);
    assert.equal(request.url, '/api/proxy');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.get('X-API-URL'), apiUrl);
    assert.equal(request.options.headers.get('Authorization'), fixtureAuth);
    assert.equal(request.options.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), { model, prompt: 'fixture prompt', n: 1, output_format: 'png' });
    assert.equal(Object.hasOwn(JSON.parse(request.options.body), 'messages'), false);
    assert.equal(assistant.content, 'mock result');
    assert.equal(request.options.signal, app.evaluate('state.abortController.signal'));
  }
  assert.equal(requests.filter(request => request.url === '/api/health').length, 1);
});

test('image inputs use the edits endpoint and gateway JSON image_url records without messages', async () => {
  const requests = [];
  const app = frontend(async (url, options) => {
    requests.push({ url, options });
    return url === '/api/health' ? healthResponse() : completionResponse();
  });
  const sourceImage = 'https://images.example/input.png';
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'edit fixture' },
    { type: 'image_url', image_url: { url: sourceImage } }
  ] }];
  await app.context.requestImageGeneration(messages, { id: 'fixture' });
  const request = requests.at(-1);
  assert.equal(request.url, '/api/proxy');
  assert.equal(request.options.headers.get('X-API-URL'), editApiUrl);
  assert.equal(request.options.headers.get('Authorization'), fixtureAuth);
  assert.equal(request.options.headers.get('Content-Type'), 'application/json');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    model: 'gpt-image-2.5-flare', prompt: 'edit fixture', n: 1, output_format: 'png',
    images: [{ image_url: sourceImage }]
  });
  assert.equal(Object.hasOwn(body, 'messages'), false);
});

test('image prompts preserve system instructions and current requirements while removing historical image markers and bytes', async () => {
  const app = frontend();
  const dataUrl = 'data:image/png;base64,aGlzdG9yeQ==';
  const messages = [
    { role: 'system', content: '使用暖色，保留标题' },
    { role: 'assistant', content: `历史结果 ![生成图片](IDX:old-image) ![历史图片](${dataUrl})` },
    { role: 'user', content: [
      { type: 'text', text: '将海报背景改为淡黄' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }
  ];
  const request = await app.context.buildImageRequest(messages);
  assert.match(request.body.prompt, /使用暖色，保留标题/);
  assert.match(request.body.prompt, /将海报背景改为淡黄/);
  assert.doesNotMatch(request.body.prompt, /IDX:|data:image|aGlzdG9yeQ==/);
  assert.equal(Object.hasOwn(request.body, 'messages'), false);
  assert.equal(request.url, editApiUrl);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.images)), [{ image_url: dataUrl }]);
});

test('a static server health 404 leaves API requests direct', async () => {
  const requests = [];
  const app = frontend(async (url, options) => {
    requests.push({ url, options });
    return url === '/api/health' ? healthResponse(null, 404) : completionResponse();
  });
  await app.context.requestImageGeneration([], { id: 'fixture' });
  const request = requests.at(-1);
  assert.equal(request.url, apiUrl);
  assert.equal(request.options.headers.get('X-API-URL'), null);
  assert.equal(request.options.headers.get('Authorization'), fixtureAuth);
});

test('unrelated health responses cannot enable the local proxy', async () => {
  for (const data of [{ service: 'other-app', proxy: true }, { service: 'idea-chat', proxy: false }]) {
    const app = frontend(async () => healthResponse(data));
    assert.equal(await app.context.hasLocalApiProxy(), false);
  }
});

test('a failed health probe falls back to direct API requests', async () => {
  const requests = [];
  const app = frontend(async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/health') throw new TypeError('Failed to fetch');
    return completionResponse();
  });
  await app.context.requestImageGeneration([], { id: 'fixture' });
  assert.equal(requests.at(-1).url, apiUrl);
});

test('request cancellation preserves AbortError for direct and proxy requests', async () => {
  for (const useProxy of [false, true]) {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const app = frontend(async url => {
      if (url === '/api/health') return useProxy ? healthResponse() : healthResponse(null, 404);
      throw abortError;
    });
    await assert.rejects(app.context.requestImageGeneration([], { id: 'fixture' }), error => error === abortError);
  }
});

test('cancellation while health is pending prevents the API request', async () => {
  let resolveHealth;
  let apiCalls = 0;
  const app = frontend(async url => {
    if (url === '/api/health') return new Promise(resolve => { resolveHealth = resolve; });
    apiCalls++;
    return completionResponse();
  });
  const request = app.context.requestImageGeneration([], { id: 'fixture' });
  app.evaluate('state.abortController.abort();');
  resolveHealth(healthResponse());
  await assert.rejects(request, error => error.name === 'AbortError');
  assert.equal(apiCalls, 0);
});

test('an explicit aborted signal remains valid after the shared controller is cleared', async () => {
  let requests = 0;
  const app = frontend(async () => { requests++; return completionResponse(); });
  const controller = new AbortController();
  controller.abort();
  app.evaluate('state.abortController = null;');
  await assert.rejects(
    app.context.requestImageGeneration([], { id: 'fixture' }, controller.signal),
    error => error.name === 'AbortError'
  );
  assert.equal(requests, 0);
});

test('AbortError during JSON body consumption remains a cancellation', async () => {
  const abortError = new DOMException('The operation was aborted', 'AbortError');
  const app = frontend(async url => url === '/api/health' ? healthResponse() : {
    ok: true, json: async () => { throw abortError; }
  });
  await assert.rejects(app.context.requestImageGeneration([], { id: 'fixture' }), error => error === abortError);
});

test('direct network failures have an actionable CORS message', async () => {
  const app = frontend(async url => {
    if (url === '/api/health') return healthResponse(null, 404);
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(app.context.requestImageGeneration([], { id: 'fixture' }), error =>
    /CORS/.test(error.message) && /node server\.js/.test(error.message));
});

test('proxy network failures identify the local forwarding service', async () => {
  const app = frontend(async url => {
    if (url === '/api/health') return healthResponse();
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(app.context.requestImageGeneration([], { id: 'fixture' }), /无法连接本地 API 转发服务/);
});

test('invalid or credential-bearing API URLs are rejected before any request', async () => {
  let requests = 0;
  const app = frontend(async () => { requests++; return completionResponse(); });
  for (const url of ['invalid-url', 'file:///C:/Windows/win.ini', 'https://user:password@api.example/v1/chat/completions']) {
    await assert.rejects(app.context.fetchApiRequest(url, {}), /有效的 HTTP\/HTTPS API 请求地址/);
  }
  assert.equal(requests, 0);
});
