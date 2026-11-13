const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\ninit\(\);\s*updateUI\(\);\s*$/, '\n');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII=';

function app() {
  const saves = [];
  const paints = [];
  const encodings = [];
  const context = vm.createContext({
    console, URL, Headers, Blob, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById() { return { addEventListener() {} }; },
      createElement(name) {
        assert.equal(name, 'canvas');
        const canvas = {
          getContext() {
            return {
              fillRect() { paints.push('opaque-fill'); },
              drawImage(_image, _x, _y, width, height) { paints.push({ width, height }); }
            };
          },
          toDataURL(mime) {
            encodings.push({ mime, width: canvas.width, height: canvas.height });
            return `data:${mime};base64,${png}`;
          }
        };
        return canvas;
      }
    },
    Image: class {
      constructor() { this.width = 4096; this.height = 2048; }
      set src(_value) { this.onload(); }
    },
    FileReader: class {
      readAsDataURL(file) { this.onload({ target: { result: file.source } }); }
    },
    saveRecord(id, value, meta) { saves.push({ id, value, meta }); },
    imagePreviewRendered() {}
  });
  new vm.Script(source, { filename: 'index.html' }).runInContext(context);
  vm.runInContext(`
    saveImageToDB = async (id, value, meta) => saveRecord(id, value, meta);
    saveImageReferenceToDB = async (id, value) => saveRecord(id, value, {});
    renderImagePreviews = imagePreviewRendered;
  `, context);
  return { context, saves, paints, encodings };
}

test('PNG resizing uses transparent canvas pixels and encodes PNG at the size limit', () => {
  const { context, paints, encodings } = app();
  let result;
  context.compressImage(`data:image/png;base64,${png}`, 2048, 2048, 0.78, value => { result = value; });
  assert.match(result, /^data:image\/png;base64,/);
  assert.deepEqual(paints, [{ width: 2048, height: 1024 }]);
  assert.deepEqual(encodings, [{ mime: 'image/png', width: 2048, height: 1024 }]);
});

test('uploaded PNG retains PNG MIME and extension in stored metadata and preview', async () => {
  const { context, saves } = app();
  await context.addImage({ name: 'transparent.png', type: 'image/png', source: `data:image/png;base64,${png}` });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].meta.mime, 'image/png');
  assert.equal(saves[0].meta.name, 'transparent_compressed.png');
  assert.match(saves[0].value, /^data:image\/png;base64,/);
});

test('PNG base64 responses persist usable PNG data URLs and named PNG records', async () => {
  const { context, saves } = app();
  const result = await context.imageResponseToMarkdown({ output_format: 'png', data: [{ b64_json: png }] }, 'response');
  assert.equal(saves[0].value, `data:image/png;base64,${png}`);
  assert.equal(saves[0].meta.mime, 'image/png');
  assert.match(saves[0].meta.name, /\.png$/);
  assert.match(result, /!\[生成图片\]\(IDX:ci_response_/);
});

test('full PNG data URLs are not prefixed twice in API responses', async () => {
  const { context, saves } = app();
  const dataUrl = `data:image/png;base64,${png}`;
  await context.imageResponseToMarkdown({ data: [{ b64_json: dataUrl }, { url: dataUrl }, { data_url: dataUrl }] }, 'response');
  assert.equal(saves.length, 3);
  for (const record of saves) assert.equal(record.value, dataUrl);
  assert.equal(context.normalizeReturnedContent([{ b64_json: dataUrl }]), `![生成图片](${dataUrl})`);
});

test('recognized JPEG and WebP bytes are not mislabeled as PNG', () => {
  const { context } = app();
  assert.equal(context.returnedImageDataUrl('/9j/fixture', 'png'), 'data:image/jpeg;base64,/9j/fixture');
  assert.equal(context.returnedImageDataUrl('UklGRfixture', 'png'), 'data:image/webp;base64,UklGRfixture');
  assert.equal(context.returnedImageDataUrl(`data:image/jpeg;base64,${png}`), `data:image/png;base64,${png}`);
});

test('a failed PNG decode keeps the original bytes and accurate file metadata', async () => {
  const { context, saves } = app();
  vm.runInContext('compressImage = (value, _width, _height, _quality, callback) => callback(value);', context);
  await context.addImage({ name: 'original.jpeg', type: 'image/jpeg', source: 'data:image/jpeg;base64,/9j/fixture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves[0].meta.mime, 'image/jpeg');
  assert.equal(saves[0].meta.name, 'original_compressed.jpg');
  assert.equal(saves[0].value, 'data:image/jpeg;base64,/9j/fixture');
});
