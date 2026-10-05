import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = buildSync({ entryPoints: [fileURLToPath(new URL('../extension/src/background.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'Background', write: false }).outputFiles[0].text;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture(t, mode = 'always') {
  const listeners = {}, calls = [], errors = [], values = {};
  const documents = new Map([[1, 'document-1'], [2, 'document-2']]);
  const tabs = new Map([1, 2].map(id => [id, { id, windowId: id, active: true, url: `https://page.example/${id}` }]));
  const unmounts = new Map();
  const area = store => ({
    async get(keys) { return keys == null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])); },
    async set(update) { Object.assign(store, structuredClone(update)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
  });
  let previewError;
  const api = {
    action: { setBadgeText: async () => {}, onClicked: { addListener() {} } },
    runtime: {
      getURL: file => `chrome-extension://fixture/${file}`,
      sendMessage: async () => {},
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onConnect: { addListener() {} }
    },
    storage: { local: area({ sniffMode: mode }), session: area(values), onChanged: { addListener() {} } },
    webRequest: Object.fromEntries(['onBeforeSendHeaders', 'onHeadersReceived', 'onErrorOccurred'].map(name => [name, { addListener() {} }])),
    webNavigation: {
      onBeforeNavigate: { addListener: fn => { listeners.navigate = fn; } },
      onHistoryStateUpdated: { addListener() {} }
    },
    declarativeNetRequest: { async updateSessionRules() { if (previewError) throw previewError; } },
    scripting: { async executeScript(value) { calls.push(value); return [{ documentId: documents.get(value.target.tabId) }]; } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('tab_not_found'); return { ...tabs.get(id) }; },
      async query() { return [...tabs.values()]; },
      async sendMessage(id, message) {
        if (message.type === 'workspace.unmount') {
          const block = unmounts.get(id)?.shift();
          if (block) { block.started.resolve(); await block.release.promise; }
        }
        if (message.type === 'probe.identity') return { documentToken: documents.get(id) };
        return { ok: true };
      },
      onRemoved: { addListener: fn => { const previous = listeners.removed; listeners.removed = id => { previous?.(id); fn(id); }; } },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} }
    }
  };
  const timers = new Set();
  const context = { chrome: api, Error, URL, URLSearchParams, Map, Set, Number, Object, Date, Promise, TextEncoder, TextDecoder, Headers, Uint8Array, crypto: webcrypto, structuredClone,
    console: { warn() {}, error: (...args) => errors.push(args) },
    setTimeout: (fn, delay) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  };
  vm.runInNewContext(source, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  await context.Background.runtime.settings.ready;
  await context.Background.runtime.sniffing.refresh();
  const send = (message, sender = {}) => new Promise(resolve => listeners.message(message, sender, resolve));
  return {
    calls, errors, values, tabs, documents, api, runtime: context.Background.runtime, send,
    hold(id) { const block = { started: deferred(), release: deferred() }; if (!unmounts.has(id)) unmounts.set(id, []); unmounts.get(id).push(block); return block; },
    navigate(id, url = `https://page.example/${id}/next`) { tabs.get(id).url = url; listeners.navigate({ tabId: id, frameId: 0, url }); },
    probe(id, token = documents.get(id)) { return send({ type: 'probe.install', documentToken: token }, { tab: { ...tabs.get(id) }, frameId: 0, documentId: token, url: tabs.get(id)?.url }); },
    remove(id) { tabs.delete(id); documents.delete(id); listeners.removed(id); },
    failPreview(error) { previewError = error; }
  };
}

const injected = (f, id) => f.calls.filter(call => call.target.tabId === id && call.files?.includes('page-probe.js'));

test('probe installation waits for navigation cleanup and preserves the initial inline HLS discovery', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const block = f.hold(1);
  f.navigate(1);
  await block.started.promise;
  let completed = false;
  const probe = f.probe(1).then(result => { completed = true; return result; });
  await flush();
  assert.equal(completed, false);
  assert.equal(injected(f, 1).length, 0, 'the initial scan must not run before cleanup');
  block.release.resolve();
  assert.equal((await probe).ok, true);
  const url = 'https://cdn.example/inline.m3u8';
  assert.equal((await f.send({ type: 'media.add', candidate: { url, source: 'inline-script' } }, { tab: { id: 1 } })).ok, true);
  await flush();
  assert.ok((await f.send({ type: 'media.candidates', tabId: 1 })).some(item => item.url === url && item.source === 'inline-script'));
});

test('consecutive navigations share a serialized cleanup and old documents cannot install', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = f.hold(1), second = f.hold(1);
  f.navigate(1, 'https://page.example/first');
  await first.started.promise;
  const stale = f.probe(1);
  f.documents.set(1, 'document-new');
  f.navigate(1, 'https://page.example/second');
  const current = f.probe(1);
  first.release.resolve();
  await second.started.promise;
  await flush();
  assert.equal(injected(f, 1).length, 0);
  second.release.resolve();
  assert.equal((await stale).ok, false);
  assert.equal((await current).ok, true);
  assert.equal(injected(f, 1).length, 1);
  assert.equal((await f.runtime.loadTabState(1)).pageUrl, 'https://page.example/second');
});

test('a blocked navigation does not delay a different tab', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const block = f.hold(1);
  f.navigate(1);
  await block.started.promise;
  const blocked = f.probe(1);
  assert.equal((await f.probe(2)).ok, true);
  assert.equal(injected(f, 1).length, 0);
  block.release.resolve();
  assert.equal((await blocked).ok, true);
});

test('closing a tab cancels a pending installation and late cleanup cannot recreate its state', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const block = f.hold(1);
  f.navigate(1);
  await block.started.promise;
  const pending = f.probe(1);
  await flush();
  f.remove(1);
  block.release.resolve();
  assert.equal((await pending).ok, false);
  await flush();
  assert.equal(injected(f, 1).length, 0);
  assert.equal(f.values['media-candidates-v2:1'], undefined);
  assert.equal(f.runtime.sniffing.revision(1), 0);
});

test('cleanup failure blocks injection until another navigation succeeds', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send({ type: 'media.add', candidate: { url: 'https://cdn.example/video.mp4', mime: 'video/mp4' } }, { tab: { id: 1 } });
  const candidate = (await f.send({ type: 'media.candidates', tabId: 1 }))[0];
  assert.equal((await f.send({ type: 'preview.headers.apply', payload: { candidateId: candidate.id, url: candidate.url, previewSessionId: 'navigation-test', headers: { referer: 'https://page.example/1' } } }, { tab: { id: 1 } })).ok, true);
  f.failPreview(new Error('preview_cleanup_failed'));
  f.navigate(1);
  const failed = await f.probe(1);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'preview_cleanup_failed');
  assert.equal((await f.probe(1)).ok, false, 'a completed rejection must remain visible to later probes');
  assert.equal(injected(f, 1).length, 0);
  assert.ok(f.errors.length);
  f.failPreview(null);
  f.navigate(1, 'https://page.example/recovered');
  assert.equal((await f.probe(1)).ok, true);
});

test('cleanup keeps default on-open mode and a paused page inactive', { timeout: 10000 }, async t => {
  const onOpen = await fixture(t, 'on_open');
  onOpen.navigate(1);
  const unopened = await onOpen.probe(1);
  assert.equal(unopened.ok, true);
  assert.equal(unopened.active, false);
  assert.equal(injected(onOpen, 1).length, 0);
  const paused = await fixture(t);
  paused.runtime.sniffing.setPaused(1, true);
  await paused.runtime.sniffing.refresh();
  assert.equal((await paused.probe(1)).active, false);
  assert.equal(injected(paused, 1).length, 0);
});
