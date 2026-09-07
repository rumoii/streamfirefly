import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent } from "vue";
import { useAppStore, DEFAULT_RESOURCE_VIEW_STATE } from "./store";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./api", () => ({ sendMessage: (message: unknown) => mocks.send(message), sendCore: (message: unknown) => mocks.send(message), extensionApi: () => ({ runtime: { sendMessage: mocks.send } }), surfaceFromUrl: () => "workspace", currentWindowId: async () => 1 }));
const context = (id: string, revision = 0) => ({ ok: true, context: { sourceContextId: id, sourceTabId: 1, pageTitle: id, candidates: [], resourceViewState: { ...DEFAULT_RESOURCE_VIEW_STATE, revision } } });
const connect = (message: any) => message.type === "native.connect" ? { ok: true, capabilities: [] } : { ok: true, tasks: [] };

describe("source context sequencing", () => {
  it("ignores failure from an obsolete context request", async () => {
    let rejectOld!: (reason: Error) => void;
    let calls = 0;
    mocks.send.mockImplementation((message: any) => message.type !== "ui.context.get" ? Promise.resolve(connect(message)) : ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve(context("new", 2)));
    let store!: ReturnType<typeof useAppStore>;
    const wrapper = mount(defineComponent({ setup() { store = useAppStore(); return () => null; } }), { global: { plugins: [createPinia()] } });
    const pending = store.refresh(); await store.refresh();
    rejectOld(new Error("old request failed")); await pending;
    expect(store.context?.sourceContextId).toBe("new");
    expect(store.error).toBe("");
    wrapper.unmount();
  });

  it("rejects a delayed old response after a newer context", async () => {
    let old!: (value: any) => void;
    let calls = 0;
    mocks.send.mockImplementation((message: any) => message.type !== "ui.context.get" ? Promise.resolve(connect(message)) : ++calls === 1 ? new Promise(resolve => { old = resolve; }) : Promise.resolve(context("new", 2)));
    let store!: ReturnType<typeof useAppStore>;
    const wrapper = mount(defineComponent({ setup() { store = useAppStore(); return () => null; } }), { global: { plugins: [createPinia()] } });
    const pending = store.refresh(); await store.refresh();
    expect(store.context?.sourceContextId).toBe("new");
    old(context("old", 1)); await pending;
    expect(store.context?.sourceContextId).toBe("new");
    wrapper.unmount();
  });

  it("does not lower the current resource revision", async () => {
    mocks.send.mockImplementation(async (message: any) => message.type === "ui.context.get" ? context("same", 1) : connect(message));
    let store!: ReturnType<typeof useAppStore>;
    const wrapper = mount(defineComponent({ setup() { store = useAppStore(); return () => null; } }), { global: { plugins: [createPinia()] } });
    await store.refresh();
    store.resourceViewState = { ...store.resourceViewState, pattern: "new filter", revision: 3 };
    await store.refresh();
    expect(store.resourceViewState.pattern).toBe("new filter");
    expect(store.resourceViewState.revision).toBe(3);
    wrapper.unmount();
  });
});
