const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\ninit\(\);\s*updateUI\(\);\s*$/, '\n');
const generationUrl = 'https://e0b00642f591.nofx.one/v1/images/generations';
const editUrl = 'https://e0b00642f591.nofx.one/v1/images/edits';

function app() {
  const records = {
    img_previous: { dataUrl: 'data:image/jpeg;base64,b2xk' },
    ci_generated: { dataUrl: 'data:image/png;base64,bGF0ZXN0' },
    img_current: { dataUrl: 'data:image/jpeg;base64,Y3VycmVudA==' }
  };
  const context = vm.createContext({
    console, URL, Headers, Blob, TextEncoder, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { location: { protocol: 'http:' } },
    document: { getElementById() { return { addEventListener() {} }; } },
    lookupImageRecord: id => records[id] || null
  });
  new vm.Script(script, { filename: 'index.html' }).runInContext(context);
  vm.runInContext(`
    getImageRecordFromDB = async id => lookupImageRecord(id);
    state.settings.contextMode = 'auto';
    state.settings.apiKey = 'test-key-do-not-use';
  `, context);
  return { context, evaluate: expression => vm.runInContext(expression, context) };
}

function chatWith(current) {
  return { messages: [
    { id: 'first', role: 'user', content: '原始图片要求', images: ['img_previous'] },
    { id: 'result', role: 'assistant', content: '![生成图片](IDX:ci_generated)\n上一轮文字说明' },
    current
  ] };
}

test('an explicit previous-image reference edits the latest assistant image', async () => {
  const { context } = app();
  const current = { id: 'current', role: 'user', content: '把上一张改成蓝色', images: [] };
  const request = context.buildImageRequest(await context.buildRequestMessages(chatWith(current), current));
  assert.equal(request.url, editUrl);
  assert.equal(request.body.output_format, 'png');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.images)), [
    { image_url: 'data:image/png;base64,bGF0ZXN0' }
  ]);
  assert.match(request.body.prompt, /把上一张改成蓝色/);
  assert.match(request.body.prompt, /上一轮文字说明/);
  assert.doesNotMatch(request.body.prompt, /IDX:|data:image|base64/);
});

test('current uploads take precedence over historical reference images', async () => {
  const { context } = app();
  const current = { id: 'current', role: 'user', content: '把上一张改成蓝色，参考新上传图', images: ['img_current'] };
  const request = context.buildImageRequest(await context.buildRequestMessages(chatWith(current), current));
  assert.equal(request.url, editUrl);
  assert.equal(request.body.output_format, 'png');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.images)), [
    { image_url: 'data:image/jpeg;base64,Y3VycmVudA==' }
  ]);
  assert.doesNotMatch(request.body.prompt, /IDX:|data:image/);
});

test('an independent prompt generates without historical images or requirements', async () => {
  const { context } = app();
  const current = { id: 'current', role: 'user', content: '画一只猫', images: [] };
  const request = context.buildImageRequest(await context.buildRequestMessages(chatWith(current), current));
  assert.equal(request.url, generationUrl);
  assert.equal(request.body.output_format, 'png');
  assert.equal(request.body.images, undefined);
  assert.match(request.body.prompt, /画一只猫/);
  assert.doesNotMatch(request.body.prompt, /原始图片要求|上一轮文字说明/);
});

test('image requests preserve system requirements but strip historical base64', async () => {
  const { context, evaluate } = app();
  evaluate("state.settings.systemPrompt = '保持水彩风格';");
  const current = { id: 'current', role: 'user', content: '继续写说明', images: [] };
  const chat = { messages: [
    { id: 'first', role: 'user', content: '旧要求', images: [] },
    { id: 'result', role: 'assistant', content: '历史文字 ![图片](data:image/png;base64,Ymln) data:image/jpeg;base64,cGF5bG9hZA==' },
    current
  ] };
  const request = context.buildImageRequest(await context.buildRequestMessages(chat, current));
  assert.equal(request.body.output_format, 'png');
  assert.match(request.body.prompt, /保持水彩风格/);
  assert.match(request.body.prompt, /历史文字/);
  assert.doesNotMatch(request.body.prompt, /data:image|Ymln|cGF5bG9hZA==/);
  assert.equal(request.body.images, undefined);
});

test('legacy malicious API addresses cannot override fixed image endpoints', () => {
  const { context, evaluate } = app();
  evaluate(`
    state.settings.apiBaseUrl = 'https://evil.example/v1/chat/completions?route=stolen';
    state.settings.apiProfiles = [{
      id: 'legacy', apiUrl: 'https://evil.example/custom/create/', apiKey: 'old-test-key'
    }];
    state.settings.activeApiProfileId = 'legacy';
  `);
  assert.equal(context.getImageApiUrl(false), generationUrl);
  assert.equal(context.getImageApiUrl(true), editUrl);
  const generation = context.buildImageRequest([{ role: 'user', content: '生成测试图片' }]);
  assert.equal(generation.url, generationUrl);
  assert.equal(generation.body.output_format, 'png');
  const edit = context.buildImageRequest([{ role: 'user', content: [
    { type: 'text', text: '编辑测试图片' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } }
  ] }]);
  assert.equal(edit.url, editUrl);
  assert.equal(edit.body.output_format, 'png');
});
