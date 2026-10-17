import { ref } from "vue";
import { createDownloadsState } from "./state";
import type { DownloadTask, MediaCandidate } from "../../types";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../api", () => ({ sendMessage: send, sendCore: send }));

const sourceUrl = "https://source.test/live.m3u8";
const task: DownloadTask = { id: "live", title: "直播", url: sourceUrl, state: "interrupted", progress: 40, live_recording: true, source_candidate_id: "source", resume_requirement: "authorization_required" };
beforeEach(() => send.mockReset());

describe("download controls", () => {
  it.each(["authorization_required", "authorization_and_key_required", "key_required"] as const)("stops without a source candidate or new credentials: %s", async requirement => {
    const state = createDownloadsState(ref([]));
    const stopping = { ...task, state: "stopping" };
    send.mockResolvedValue({ ok: true, task: stopping });
    await state.controlTask({ ...task, resume_requirement: requirement }, "stop");
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "task.control", payload: { id: task.id, action: "stop", resumeContext: null } });
    expect(state.tasks.value).toEqual([stopping]);
  });

  it("does not attach a remaining candidate's credentials when stopping", async () => {
    const candidate: MediaCandidate = { id: "source", type: "hls", url: sourceUrl, requestHeaders: { authorization: "Bearer test" } };
    const state = createDownloadsState(ref([candidate]));
    send.mockResolvedValue({ ok: true });
    await state.controlTask(task, "stop");
    expect(send.mock.calls[0][0].payload.resumeContext).toBeNull();
  });

  it.each(["resume", "retry", "reauthorize"])("still requires the source for %s", async action => {
    const state = createDownloadsState(ref([]));
    await expect(state.controlTask(task, action)).rejects.toThrow("hls_source_candidate_missing");
    expect(send).not.toHaveBeenCalled();
  });

  it("supplies fresh authorization and the manual key when resuming", async () => {
    const candidate: MediaCandidate = { id: "source", type: "hls", url: sourceUrl, referer: "https://source.test/watch", requestHeaders: { authorization: "Bearer fresh" } };
    const state = createDownloadsState(ref([candidate]));
    const keyOverride = { kind: "hex", value: "07".repeat(16) };
    send.mockResolvedValue({ ok: true });
    await state.controlTask(task, "resume", { keyOverride });
    expect(send.mock.calls[0][0].payload.resumeContext).toEqual({ keyOverride, requestHeaders: candidate.requestHeaders, referer: candidate.referer });
  });

  it("reports a native stop failure", async () => {
    const state = createDownloadsState(ref([]));
    send.mockResolvedValue({ ok: false, error: "hls_checkpoint_missing" });
    await expect(state.controlTask(task, "stop")).rejects.toThrow("hls_checkpoint_missing");
    expect(state.tasks.value).toEqual([]);
  });
});
