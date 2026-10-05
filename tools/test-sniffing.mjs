import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { editionDefine } from './edition.mjs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = buildSync({ entryPoints: [fileURLToPath(new URL('../extension/src/sniffing.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'Module', write: false , define: editionDefine('chrome-store') }).outputFiles[0].text;
const scope = {};
vm.runInNewContext(source, scope);
const { createSniffing } = scope.Module;

const tabs = [
  { id: 1, windowId: 10, active: true },
  { id: 2, windowId: 10, active: false },
  { id: 3, windowId: 20, active: true }
];
const signals = [];
let connectListener;
const storageListeners = [];
const settingsValue = { sniffMode: 'on_open' };
const settings = { ready: Promise.resolve(), get: () => settingsValue };
const api = {
  runtime: { getURL: path => `chrome-extension://test/${path}`, onConnect: { addListener: listener => { connectListener = listener; } } },
  storage: { onChanged: { addListener: listener => storageListeners.push(listener) } },
  tabs: {
    query: async query => tabs.filter(tab => (query.windowId == null || query.windowId === tab.windowId) && (!query.active || tab.active)),
    sendMessage: async (tabId, message) => { signals.push({ tabId, active: message.active }); }
  },
  scripting: { executeScript: async () => [] }
};
function port(surface, tab) {
  let messageListener, disconnectListener;
  const connection = {
    name: 'sniffing-ui',
    sender: tab ? { tab } : { url: 'chrome-extension://test/dist/app.html?surface=sidebar' },
    onMessage: { addListener: listener => { messageListener = listener; } },
    onDisconnect: { addListener: listener => { disconnectListener = listener; } },
    replies: [],
    postMessage(message) { this.replies.push(message); },
    announce(windowId) { messageListener({ surface, windowId }); },
    disconnect() { disconnectListener(); }
  };
  connectListener(connection);
  return connection;
}

const sniffing = createSniffing(api, settings);
assert.equal(sniffing.allowed(1), false, 'default mode must wait for the UI');
const sidebar = port('sidebar');
sidebar.announce(10);
await sniffing.refresh();
assert.equal(sniffing.allowed(1), true);
assert.equal(sniffing.allowed(2), false);
assert.equal(sniffing.allowed(3), false);
assert.ok(sidebar.replies.some(reply => reply.ready));

tabs[0].active = false;
tabs[1].active = true;
const firstRevision = sniffing.revision(1);
await sniffing.refresh();
assert.equal(sniffing.allowed(1), false);
assert.equal(sniffing.allowed(2), true);
assert.ok(sniffing.revision(1) > firstRevision, 'late candidates from the previous tab need invalidation');
sniffing.setPaused(2, true);
await sniffing.refresh();
assert.equal(sniffing.allowed(2), false, 'manual pause must stop the active probe');
sniffing.setPaused(2, false);
await sniffing.refresh();
assert.equal(sniffing.allowed(2), true);

const workspace = port('workspace', tabs[1]);
workspace.announce();
await sniffing.refresh();
const stableRevision = sniffing.revision(2);
const signalCount = signals.length;
const unrelated = sniffing.refresh();
assert.equal(sniffing.allowed(2), true, 'an unrelated refresh must not pause the active tab');
await unrelated;
assert.equal(sniffing.revision(2), stableRevision, 'an unrelated refresh must keep in-flight discoveries');
assert.equal(signals.length, signalCount, 'an unrelated refresh must not re-signal the page');
sidebar.disconnect();
await sniffing.refresh();
assert.equal(sniffing.allowed(2), true, 'workspace must retain ownership when the sidebar closes');
sniffing.releaseWorkspace(2);
await sniffing.refresh();
assert.equal(sniffing.allowed(2), false);
assert.ok(signals.some(signal => signal.tabId === 2 && signal.active === false));
workspace.disconnect();

settingsValue.sniffMode = 'always';
for (const listener of storageListeners) listener({ sniffMode: { newValue: 'always' } }, 'local');
await sniffing.refresh(true);
assert.ok(tabs.every(tab => sniffing.allowed(tab.id)), 'always mode must cover all tabs');
settingsValue.sniffMode = 'on_open';
for (const listener of storageListeners) listener({ sniffMode: { newValue: 'on_open' } }, 'local');
await sniffing.refresh(true);
assert.ok(tabs.every(tab => !sniffing.allowed(tab.id)));
console.log('Sniffing presence, tab switching, workspace handoff and mode changes passed');
