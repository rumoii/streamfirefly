import { createTaskState } from "./task-state";

describe("task snapshots", () => {
  it("retains the last snapshot on host failure", async () => {
    const state = createTaskState(async () => ({ ok: false, error: "native_host_disconnected" }));
    state.tasks.value = [{ id: "task", title: "task", state: "running", progress: 10 }];
    await state.refresh();
    expect(state.tasks.value).toHaveLength(1);
    expect(state.connection.value).toBe("disconnected");
  });

  it("does not overwrite a newer progress event with an older list", async () => {
    let complete!: (value: any) => void;
    const state = createTaskState(async message => message.type === "native.connect" ? { ok: true, capabilities: [] } : new Promise(resolve => { complete = resolve; }));
    const pending = state.refresh();
    await Promise.resolve(); await Promise.resolve();
    state.receive({ type: "task.progress", task: { id: "task", title: "task", state: "running", progress: 90 } });
    complete({ ok: true, tasks: [{ id: "task", progress: 10 }] });
    await pending;
    expect(state.tasks.value[0].progress).toBe(90);
    state.dispose();
  });

  it("ignores a response after disposal", async () => {
    let complete!: (value: any) => void;
    const state = createTaskState(async () => new Promise(resolve => { complete = resolve; }));
    const pending = state.refresh();
    state.dispose(); complete({ ok: true, tasks: [{ id: "late" }] }); await pending;
    expect(state.tasks.value).toEqual([]);
  });
});
