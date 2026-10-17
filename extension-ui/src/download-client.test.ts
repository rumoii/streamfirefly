import { createDownload, prepareCandidate } from "./download-client";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./api", () => ({ sendMessage: (message: unknown) => mocks.send(message) }));

describe("download submission identity", () => {
  beforeEach(() => { mocks.send.mockReset(); });

  it("explains a denied cross-origin variant without retrying or submitting a task", async () => {
    const candidate = { id: 'hls', type: 'hls' as const, url: 'https://source.test/master.m3u8' };
    mocks.send.mockImplementation(async (message: any) => message.url === candidate.url
      ? { ok: true, url: message.url, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://cdn.test/video.m3u8\n' }
      : { ok: false, error: 'media_fetch_failed', status: 403 });
    await expect(prepareCandidate(candidate, 1)).rejects.toThrow('不会转发来源登录凭据');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls.every(([message]) => message.type === 'media.fetchText')).toBe(true);
  });

  it("recovers an accepted task after the creation response times out", async () => {
    const task = { id: "accepted", title: "video", state: "queued", progress: 0 };
    mocks.send.mockResolvedValueOnce({ ok: false, error: "native_host_timeout" }).mockResolvedValueOnce({ ok: true, task });
    expect(await createDownload({ url: "https://media.example/video.mp4" }, "request")).toEqual(task);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "task.find", payload: { requestId: "request" } });
  });

  it("reuses the identity only after confirming no task was accepted", async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, error: "native_host_disconnected" }).mockResolvedValueOnce({ ok: true, task: null }).mockResolvedValueOnce({ ok: true, task: { id: "accepted" } });
    await createDownload({ url: "https://media.example/video.mp4" }, "same-request");
    expect(mocks.send.mock.calls[0][0]).toEqual(mocks.send.mock.calls[2][0]);
  });

  it("does not create another task when reconciliation is unavailable", async () => {
    mocks.send.mockResolvedValue({ ok: false, error: "native_host_disconnected" });
    await expect(createDownload({}, "unknown-result")).rejects.toThrow("提交结果尚未确认");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("rejects Blob media before any download or Native request", async () => {
    await expect(prepareCandidate({ id: "blob", url: "blob:https://media.example/source", type: "video" }, 1)).rejects.toThrow("blob_resource_requires_capture");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
