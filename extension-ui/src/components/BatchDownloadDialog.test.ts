import { flushPromises, mount } from "@vue/test-utils";
import BatchDownloadDialog from "./BatchDownloadDialog.vue";
const mocks = vi.hoisted(() => ({ create: vi.fn(), prepare: vi.fn() }));
vi.mock("../download-client", () => ({ createDownload: mocks.create, prepareCandidate: mocks.prepare }));
vi.mock("../api", () => ({ sendMessage: async () => ({ ok: true, payload: { fileName: "file" } }), extensionApi: () => null }));
const candidates = ["good", "bad", "last"].map(id => ({ id, title: id, url: `http://127.0.0.1/${id}.mp4`, type: "video" }));
const props = { candidates, saveDir: "", downloadThreads: 6, sourceContextId: "page", sourceTabId: 1, connected: true };

describe("batch submission", () => {
  beforeEach(() => { mocks.create.mockReset(); mocks.prepare.mockReset(); });
  it("continues after a single failure and prevents double submission", async () => {
    mocks.prepare.mockImplementation(async candidate => ({ url: candidate.url, title: candidate.id }));
    mocks.create.mockImplementation(async payload => { if (payload.title === "bad") throw new Error("download failed"); return { title: payload.title }; });
    const wrapper = mount(BatchDownloadDialog, { props });
    await wrapper.get(".button.primary").trigger("click"); await flushPromises();
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(wrapper.text()).toContain("已入队 2 · 失败 1");
    expect(wrapper.find(".button.primary").exists()).toBe(false);
    wrapper.unmount();
  });

  it("stops unsubmitted items without cancelling accepted tasks", async () => {
    let prepared!: (value: any) => void;
    mocks.prepare.mockImplementation(() => new Promise(resolve => { prepared = resolve; }));
    const wrapper = mount(BatchDownloadDialog, { props });
    await wrapper.get(".button.primary").trigger("click");
    await wrapper.get(".dialog-actions .button").trigger("click");
    await wrapper.findAll("button").find(button => button.text() === "停止未提交项")!.trigger("click");
    prepared({ title: "good" }); await flushPromises();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("未提交");
    wrapper.unmount();
  });
});
