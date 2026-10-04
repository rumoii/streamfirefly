import type { DownloadTask } from "../../types";
import { stateIcon, stateLabel, statusLine, taskActions } from "./display";

const task = (patch: Partial<DownloadTask>): DownloadTask => ({ id: "t", title: "测试任务", state: "running", progress: 40, ...patch });
const keys = (value: DownloadTask) => { const { primary, menu } = taskActions(value); return { primary: primary?.key ?? null, menu: menu.map(action => action.key) }; };

describe("download task display", () => {
  it("offers one inline action per state and keeps the rest in the menu", () => {
    expect(keys(task({ state: "running" }))).toEqual({ primary: "pause", menu: ["cancel", "delete"] });
    expect(keys(task({ state: "queued" }))).toEqual({ primary: "pause", menu: ["cancel", "delete"] });
    expect(keys(task({ state: "pausing" }))).toEqual({ primary: null, menu: ["cancel", "delete"] });
    expect(keys(task({ state: "paused" }))).toEqual({ primary: "resume", menu: ["cancel", "delete"] });
    expect(keys(task({ state: "cancelling" }))).toEqual({ primary: null, menu: ["delete"] });
    expect(keys(task({ live_recording: true, state: "stopping" }))).toEqual({ primary: null, menu: ["delete"] });
    expect(keys(task({ state: "failed" }))).toEqual({ primary: "retry", menu: ["delete"] });
    expect(keys(task({ state: "cancelled" }))).toEqual({ primary: "retry", menu: ["delete"] });
    expect(keys(task({ state: "succeeded", progress: 100 }))).toEqual({ primary: null, menu: ["delete"] });
  });

  it("puts stop-and-save first for live recordings", () => {
    expect(keys(task({ live_recording: true, phase: "recording" }))).toEqual({ primary: "stop", menu: ["pause", "cancel", "delete"] });
    expect(keys(task({ live_recording: true, state: "paused" }))).toEqual({ primary: "stop", menu: ["resume", "cancel", "delete"] });
  });

  it("resumes interrupted tasks only when the requirement can be met here", () => {
    expect(taskActions(task({ state: "interrupted", resume_requirement: "key_required" })).primary).toMatchObject({ key: "resume", label: "输入密钥并继续", icon: "key" });
    expect(taskActions(task({ state: "interrupted", resume_requirement: "authorization_required" })).primary?.label).toBe("重新授权并继续");
    expect(keys(task({ state: "interrupted", resume_requirement: "dash_reparse_required" }))).toEqual({ primary: null, menu: ["delete"] });
    expect(keys(task({ state: "interrupted" }))).toEqual({ primary: "retry", menu: ["delete"] });
  });

  it("describes phases, progress and failures in one status line", () => {
    expect(stateLabel(task({ phase: "downloading_segments" }))).toBe("正在下载切片");
    expect(stateLabel(task({ phase: "merging" }))).toBe("正在无转码合并");
    expect(statusLine(task({ speed_bytes_per_second: 2 * 1024 * 1024, downloaded_bytes: 10 * 1024 * 1024, total_bytes: 40 * 1024 * 1024, eta_seconds: 75 }))).toBe("正在下载 · 2.0 MB/s · 10 MB / 40 MB · 剩余 01:15");
    expect(statusLine(task({ state: "failed", message: "HTTP 403" }))).toBe("下载失败 · HTTP 403");
    expect(statusLine(task({ live_recording: true, phase: "recording", recorded_duration: 125 }))).toBe("正在录制直播 · 已录制 2分5秒");
    expect(stateIcon(task({ live_recording: true }))).toBe("broadcast");
    expect(stateIcon(task({ state: "succeeded" }))).toBe("circle-check");
  });
});
