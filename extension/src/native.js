const MISSING_HOST = /native messaging host not found|native messaging host is forbidden|no such native application|permission to use native application/i;

export function createNative(api, notifyWorkspaceMessage, onTaskEvent = () => {}, onConnectionReset = () => {}) {
const native = { port: null, pending: new Map(), seq: 0, capabilities: new Set(), infoPromise: null };

function ensureNative() {
  if (native.port) return;
  try {
    native.port = api.runtime.connectNative("com.streamfirefly.native");
    native.port.onMessage.addListener(message => {
      if (["task.progress", "task.deleted", "task.persistence-error"].includes(message.type)) { try { onTaskEvent(message); } catch (_) {} api.runtime.sendMessage(message).catch?.(() => {}); notifyWorkspaceMessage(message); return; }
      const pending = native.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); native.pending.delete(message.id); pending.resolve(message); }
    });
    native.port.onDisconnect.addListener(port => {
      // Chrome/Edge report a missing or unregistered host through lastError; Firefox through port.error.
      const reason = String(api.runtime.lastError?.message || port?.error?.message || "");
      const error = MISSING_HOST.test(reason) ? "native_host_missing" : "native_host_disconnected";
      for (const pending of native.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error }); }
      native.pending.clear(); native.port = null; native.capabilities.clear(); native.infoPromise = null;
      try { onConnectionReset(error); } catch (_) {}
      const message = { type: "native.disconnected", error };
      api.runtime.sendMessage(message).catch?.(() => {});
      notifyWorkspaceMessage(message);
    });
  } catch (_) { native.port = null; }
}

function nativeRequestPromise(type, payload = {}) {
  ensureNative();
  if (!native.port) return Promise.resolve({ ok: false, error: "native_host_unavailable" });
  const id = `request-${++native.seq}`;
  return new Promise(resolve => {
    const timer = setTimeout(() => { native.pending.delete(id); resolve({ ok: false, error: "native_host_timeout" }); }, 15000);
    native.pending.set(id, { resolve, timer });
    try { native.port.postMessage({ version: 1, id, type, payload }); }
    catch (_) { clearTimeout(timer); native.pending.delete(id); resolve({ ok: false, error: "native_host_unavailable" }); }
  });
}

async function nativeInfo() {
  if (native.infoPromise) return native.infoPromise;
  const request = nativeRequestPromise("host.info").then(result => {
    native.capabilities = new Set(result?.ok && Array.isArray(result.capabilities) ? result.capabilities : []);
    const compatible = result?.ok && result.protocolVersion === 3 && ["hls-segment-engine-v1", "task-queue-v1", "task-idempotency-v1", "integration-program-v1", "capture-stream-v1", "network-policy-v1"].every(capability => native.capabilities.has(capability));
    return { ok: Boolean(compatible), error: compatible ? undefined : result?.ok ? "native_host_incompatible" : result?.error || "native_host_disconnected", capabilities: compatible ? [...native.capabilities] : [] };
  });
  native.infoPromise = request;
  const result = await request;
  if (!result.ok && native.infoPromise === request) native.infoPromise = null;
  return result;
}

return { nativeRequestPromise, nativeInfo };
}
