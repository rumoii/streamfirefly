import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { editionDefine, resolveEdition } from './edition.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const blockedUrls = ['https://www.youtube.com/watch?v=1', 'https://m.youtube.com/watch?v=1', 'https://youtu.be/1', 'https://www.youtube-nocookie.com/embed/1', 'https://rr1---sn-a.googlevideo.com/videoplayback?id=1'];

function platform(edition) {
  const source = buildSync({ entryPoints: [path.join(root, 'extension/src/platform.js')], bundle: true, format: 'iife', globalName: 'Platform', write: false, define: editionDefine(edition) }).outputFiles[0].text;
  const scope = { URL, crypto: globalThis.crypto };
  vm.runInNewContext(`${source};globalThis.Platform=Platform;`, scope);
  return scope.Platform;
}

test('edition names are validated', () => {
  assert.equal(resolveEdition(undefined), 'general');
  assert.equal(resolveEdition('chrome-store'), 'chrome-store');
  assert.throws(() => resolveEdition('store'), /Unknown STREAMFIREFLY_EDITION/);
});

test('chrome-store edition blocks YouTube hosts and general edition does not', () => {
  const store = platform('chrome-store'), general = platform('general');
  assert.equal(store.EDITION, 'chrome-store');
  assert.equal(general.EDITION, 'general');
  for (const url of blockedUrls) {
    assert.equal(store.blockedSite(url), true, url);
    assert.throws(() => store.assertSiteAllowed('https://media.example/a.mp4', url), /site_blocked/);
    assert.equal(general.blockedSite(url), false, url);
    assert.doesNotThrow(() => general.assertSiteAllowed(url));
  }
  assert.equal(store.blockedSite('https://media.example/a.mp4'), false);
});

test('site restrictions are defined only in platform.js', () => {
  for (const directory of ['extension/src', 'extension-ui/src', 'shared']) {
    for (const file of fs.readdirSync(path.join(root, directory), { recursive: true })) {
      if (!/\.(js|ts|vue)$/.test(file) || /\.test\.ts$/.test(file) || file === 'platform.js') continue;
      const text = fs.readFileSync(path.join(root, directory, file), 'utf8');
      assert.doesNotMatch(text, /googlevideo|youtu\.be|youtube-nocookie/i, `${directory}/${file}`);
    }
  }
});
