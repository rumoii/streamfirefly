import { defaultDiscovery, detectResource, validateDiscovery } from "../shared/discovery";
import { integrationDefaults, validateIntegrations } from "../shared/integrations";
import { renderTemplate } from "../shared/templates";
import { defaultExtraction, validateExtraction, extractResource, extractAddress } from "../shared/extraction";
let extraction = defaultExtraction();
let discovery = defaultDiscovery();
let integrations = integrationDefaults();
let templates = { version: 1, hls: "${url}", dash: "${url}", other: "${url}", filename: "" };
const candidates = [{ id: "fixture-video", pageTitle: "测试视频", type: "video", url: `${location.origin}/fixture.mp4`, pageUrl: location.origin, size: 4096, duration: 30 }];
const view = { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "", sortMode: "detected", collapsed: false, expandedId: "", revision: 0 };
const context = { sourceTabId: 1, sourceContextId: "fixture-page", pageUrl: location.origin, pageTitle: "本地功能夹具", supported: true, paused: false, candidates, resourceViewState: view };
const listeners = new Set<Function>();
const captureSource = { id: "1", frameId: 2, documentToken: "fixture-doc", url: "http://localhost/player", state: "open", tracks: ["video/mp4"] };
let captureSession: any = null;
let deep = { enabled: false, siteRemembered: false, requiresReload: false, keys: [], frames: [{ frameId: 0, url: location.origin, state: "disabled" }, { frameId: 2, url: "http://localhost/player", state: "disabled" }] };
const api = {
  windows: { getCurrent: async () => ({ id: 1 }) },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: {
    getURL: (value: string) => `${location.origin}/${value}`,
    onMessage: { addListener: (listener: Function) => listeners.add(listener), removeListener: (listener: Function) => listeners.delete(listener) },
    sendMessage: async (message: { type: string; payload?: any; patch?: object }) => {
      const payload = message.payload;
      try {
        switch (message.type) {
          case "ui.context.get": return { ok: true, context };
          case "ui.resource-state.patch": Object.assign(view, message.patch); return { ok: true, state: view };
          case "native.connect": return { ok: true, capabilities: ["hls-selection-v1", "hls-segment-engine-v1", "task-queue-v1", "task-idempotency-v1", "integration-program-v1", "capture-stream-v1"] };
          case "task.list": return { ok: true, tasks: [] };
          case "deep.status": return { ok: true, value: structuredClone(deep) };
          case "deep.set": deep = { ...deep, enabled: payload.enabled, siteRemembered: payload.remember && payload.enabled, requiresReload: payload.enabled, frames: deep.frames.map(frame => ({ ...frame, state: payload.enabled ? "ready" : "disabled" })) }; return { ok: true, value: structuredClone(deep) };
          case "capture.context": return { ok: true, value: context };
          case "capture.sources": return { ok: true, value: { sources: [captureSource], frames: [{ frameId: 2, url: captureSource.url, state: "ready" }, { frameId: 3, url: "about:blank", state: "unsupported" }] } };
          case "capture.list": return { ok: true, value: captureSession ? [structuredClone(captureSession)] : [] };
          case "capture.open": captureSession = { id: "fixture-capture", tabId: 1, source: captureSource, state: "capturing", bytes: 1048576, tracks: [{ id: 0, mime: "video/mp4", bytes: 1048576, initialized: true }], outputs: [] }; return { ok: true, value: { id: captureSession.id } };
          case "capture.close": captureSession.state = "partial"; captureSession.error = "capture_source_unavailable"; return { ok: true };
          case "discovery.get": return { ok: true, value: { config: structuredClone(discovery), disabled: {}, error: "" } };
          case "discovery.save": discovery = validateDiscovery(payload); return { ok: true, value: { config: discovery } };
          case "discovery.test": return { ok: true, value: await detectResource(payload.sample, validateDiscovery(payload.config), async (pattern, flags, value) => new RegExp(pattern, flags).test(value), true) };
          case "extraction.get": return { ok: true, value: { config: structuredClone(extraction), disabled: {}, error: "" } };
          case "extraction.save": extraction = validateExtraction(payload); return { ok: true, value: { config: extraction, disabled: {}, error: "", cleanup: { status: "complete" } } };
          case "extraction.test": return { ok: true, value: await extractResource(payload.sample, validateExtraction(payload.config), async (rule, url) => extractAddress(rule, url)) };
          case "integration.get": return { ok: true, value: { config: structuredClone(integrations), receipts: [], error: "" } };
          case "integration.save": integrations = validateIntegrations(payload); return { ok: true, value: { config: integrations } };
          case "integration.secret": return { ok: true };
          case "template.render": return { ok: true, value: renderTemplate(payload.template, payload.values) };
          case "templates.get": return { ok: true, value: structuredClone(templates) };
          case "templates.save": templates = structuredClone(payload); return { ok: true, value: structuredClone(templates) };
          default: return { ok: false, error: "此夹具不执行外部操作" };
        }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "操作失败" }; }
    }
  }
};
Object.defineProperty(globalThis, "chrome", { configurable: true, value: api });
