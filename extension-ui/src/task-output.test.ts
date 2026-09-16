import { describe, expect, it } from "vitest";
import { taskOutputLabel } from "./task-output";
import type { DownloadTask, TaskOutput } from "./types";

const output = (path: string, kind: TaskOutput["kind"] = "media"): TaskOutput => ({ kind, path, state: "queued" });
const task = (patch: Partial<DownloadTask> = {}): DownloadTask => ({ id: "task", title: "资源", state: "queued", progress: 0, ...patch });

describe("task output labels", () => {
  it("uses MIME and file extension for primary media", () => {
    expect(taskOutputLabel(task({ mime: "image/jpeg" }), output("C:\\Downloads\\photo.jpg"))).toBe("图片");
    expect(taskOutputLabel(task({ mime: "audio/mpeg" }), output("C:\\Downloads\\track.mp3"))).toBe("音频");
    expect(taskOutputLabel(task({ mime: "application/octet-stream" }), output("C:\\Downloads\\clip.webm"))).toBe("视频");
    expect(taskOutputLabel(task({ mime: "application/octet-stream" }), output("C:\\Downloads\\unknown.bin"))).toBe("媒体");
  });

  it("keeps adaptive streams and subtitles explicit", () => {
    expect(taskOutputLabel(task({ hls_selection: true }), output("C:\\Downloads\\stream.mp4"))).toBe("视频");
    expect(taskOutputLabel(task(), { ...output("C:\\Downloads\\stream.zh.vtt", "subtitle"), language: "zh-CN" })).toBe("zh-CN");
  });
});
