// @ts-expect-error The background module is JavaScript; exercise its production implementation.
import { createWorkspace } from "../../extension/src/workspace.js";

function fixture() {
  const messages: { tabId: number; message: any }[] = [];
  const tabs = [{ id: 1, windowId: 10, url: "https://example.test/a" }, { id: 2, windowId: 10, url: "https://example.test/b" }];
  let autoReady = true;
  const api = { scripting: { executeScript: vi.fn(async () => []) }, tabs: { query: vi.fn(async () => tabs), sendMessage: vi.fn(async (tabId: number, message: any) => { messages.push({ tabId, message }); if (message.type === "workspace.navigate" && autoReady) workspace.markReady(10, tabId, message.attemptId); return { ok: true }; }) } };
  const workspace = createWorkspace(api, vi.fn(async () => {}), vi.fn());
  return { api, workspace, messages, tabs, setAutoReady: (value: boolean) => { autoReady = value; } };
}
afterEach(() => vi.useRealTimers());
describe("workspace ownership and readiness", () => {
  it("preserves the previous tab when replacement injection fails", async () => {
    const f = fixture();
    expect((await f.workspace.openWorkspace(f.tabs[0])).ok).toBe(true);
    f.messages.length = 0;
    f.api.scripting.executeScript.mockRejectedValueOnce(new Error("injection denied"));
    expect((await f.workspace.openWorkspace(f.tabs[1])).ok).toBe(false);
    expect(f.messages.some(entry => entry.tabId === 1 && entry.message.type === "workspace.unmount")).toBe(false);
    f.workspace.notifyWorkspaceMessage({ type: "task.progress" });
    expect(f.messages.at(-1)?.tabId).toBe(1);
  });
  it("ignores forged and late readiness and cleans up a timeout", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setAutoReady(false);
    const operation = f.workspace.openWorkspace(f.tabs[0]);
    await vi.advanceTimersByTimeAsync(0);
    const attempt = f.messages.find(entry => entry.message.type === "workspace.navigate")!.message.attemptId;
    expect(f.workspace.markReady(99, 1, attempt)).toBe(false);
    expect(f.workspace.markReady(10, 1, "wrong")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await operation).toMatchObject({ ok: false, error: "workspace_ready_timeout" });
    expect(f.workspace.markReady(10, 1, attempt)).toBe(false);
    expect(f.messages.some(entry => entry.message.type === "workspace.unmount")).toBe(true);
  });
  it("serializes duplicate opens, acknowledges every navigation and never reopens a sidebar on close", async () => {
    const f = fixture();
    expect((await Promise.all([f.workspace.openWorkspace(f.tabs[0], "resources", "", "panel"), f.workspace.openWorkspace(f.tabs[0], "downloads")])).every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect(f.api.scripting.executeScript).toHaveBeenCalledTimes(1);
    const navigation = f.messages.filter(entry => entry.message.type === "workspace.navigate");
    expect(navigation.map(entry => entry.message.displayMode)).toEqual(["panel", "workspace"]);
    await f.workspace.closeWorkspace(f.tabs[0]);
    await f.workspace.closeWorkspace(f.tabs[0]);
    f.messages.length = 0; f.workspace.notifyWorkspaceMessage({ type: "task.progress" });
    expect(f.messages).toHaveLength(0);
  });
  it("does not publish ownership after closing during initialization", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setAutoReady(false);
    const operation = f.workspace.openWorkspace(f.tabs[0]); await vi.advanceTimersByTimeAsync(0);
    const attempt = f.messages.find(entry => entry.message.type === "workspace.navigate")!.message.attemptId;
    await f.workspace.closeWorkspace(f.tabs[0]);
    expect(await operation).toMatchObject({ ok: false });
    expect(f.workspace.markReady(10, 1, attempt)).toBe(false);
    f.messages.length = 0; f.workspace.notifyWorkspaceMessage({ type: "task.progress" });
    expect(f.messages).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
