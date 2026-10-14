<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { buildHlsPlan, planSelectionFor, type HlsSelectionSnapshot } from "../download-plan";
import { deriveMediaPlaylist, segmentRangeForTime, type HlsManifest, type HlsTrack } from "../media";
import { createSelectionPreviewSession, type SelectionPreviewSession } from "../hls-selection-preview";
import { loadHls, PREVIEW_HLS_CONFIG, type HlsConstructor } from "../hls-loader";
import { humanError } from "../store";
import { sendMessage } from "../api";
import { formatDuration } from "../format";
import SfIcon from "../ui/SfIcon.vue";

type PreviewState = "idle" | "preparing" | "playing" | "paused" | "ended" | "failed";

const STALE = "preview_stale";
const PREPARE_TIMEOUT_MS = 15000;
const REPLAY_HEADERS = ["referer", "origin", "authorization", "cookie", "user-agent"];
const STATE_LABELS: Record<PreviewState, string> = { idle: "未开始", preparing: "准备中", playing: "播放中", paused: "已暂停", ended: "已到终点", failed: "预览失败" };

const props = defineProps<{ snapshot: HlsSelectionSnapshot | null; loadTrack: (track: HlsTrack, options?: { restrictOrigin?: boolean }) => Promise<HlsManifest>; poster?: string | null; canStart?: boolean }>();
const emit = defineEmits<{ start: [] }>();

interface PreviewRun {
  snapshot: HlsSelectionSnapshot;
  sessionId: string;
  previewSessionId: string;
  session: SelectionPreviewSession | null;
  hls: InstanceType<HlsConstructor> | null;
  deadlineTimer: number;
  endTimer: number;
  wait: { settle: (ok: boolean, error?: Error) => void } | null;
  terminated: boolean;
  loadStopped: boolean;
  origin: number;
  networkRecoveries: number;
  mediaRecoveries: number;
}

const state = ref<PreviewState>("idle");
const error = ref("");
const notice = ref("");
const mediaElement = ref<HTMLVideoElement | null>(null);
const localTime = ref(0);
const duration = ref(0);
const muted = ref(false);
const volume = ref(1);
const audioTail = ref(false);
const root = ref<HTMLElement | null>(null);

let current: PreviewRun | null = null;
let unmounted = false;

const canSeek = computed(() => duration.value > 0 && (state.value === "playing" || state.value === "paused" || state.value === "ended"));

function live(run: PreviewRun | null): run is PreviewRun {
  return Boolean(run && !run.terminated && !unmounted && current === run);
}

watch(() => props.snapshot, (next, previous) => {
  if (next === previous) return;
  if (!next) { terminate(current); resetToIdle(); return; }
  startSession(next);
}, { immediate: true });
onBeforeUnmount(() => { unmounted = true; terminate(current); });

function needsHeaderReplay(snapshot: HlsSelectionSnapshot): boolean {
  return Object.entries(snapshot.source.requestHeaders || {}).some(([key, value]) => REPLAY_HEADERS.includes(key.toLowerCase()) && Boolean(value));
}

function clearHeaders(run: PreviewRun) {
  void sendMessage({ type: "preview.headers.clear", previewSessionId: run.previewSessionId }).catch(() => {});
}

async function applyPreviewHeaders(run: PreviewRun) {
  const result: any = await sendMessage({ type: "preview.headers.apply", payload: { previewSessionId: run.previewSessionId, candidateId: run.snapshot.source.candidateId, url: run.snapshot.source.candidateUrl, headers: run.snapshot.source.requestHeaders } }).catch(() => null);
  if (!live(run)) {
    // The rule may have been installed after terminate() already sent its clear.
    if (result?.ok) clearHeaders(run);
    throw new Error(STALE);
  }
  if (needsHeaderReplay(run.snapshot) && !result?.ok) throw new Error("预览鉴权规则安装失败，无法安全播放此资源。");
}

function clearDeadline(run: PreviewRun) {
  clearTimeout(run.deadlineTimer);
  run.deadlineTimer = 0;
}

function terminate(run: PreviewRun | null, failMessage?: string) {
  if (!run || run.terminated) return;
  run.terminated = true;
  if (current === run) current = null;
  const media = mediaElement.value;
  media?.pause();
  if (run.hls) {
    try { run.hls.stopLoad(); } catch {}
    try { run.hls.destroy(); } catch {}
    run.hls = null;
  }
  clearDeadline(run);
  clearInterval(run.endTimer);
  run.endTimer = 0;
  if (media) {
    media.removeEventListener("timeupdate", onTimeUpdate);
    media.removeEventListener("seeking", onSeeking);
    media.removeEventListener("play", onPlay);
    media.removeEventListener("pause", onPause);
    media.removeEventListener("ended", reachEnd);
    media.removeAttribute("src");
    media.load();
  }
  run.wait?.settle(false, new Error(STALE));
  run.session?.dispose();
  run.session = null;
  clearHeaders(run);
  if (failMessage) {
    state.value = "failed";
    error.value = failMessage;
  } else if (state.value !== "failed") {
    resetToIdle();
  }
}

function resetToIdle() {
  state.value = "idle";
  error.value = "";
  notice.value = "";
  audioTail.value = false;
  localTime.value = 0;
  duration.value = 0;
}

function isPlayPolicyRejection(reason: unknown): boolean {
  const name = (reason as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

function localProgress(): number {
  const media = mediaElement.value;
  if (!media) return 0;
  return Math.min(duration.value, Math.max(0, media.currentTime - (current?.origin ?? 0)));
}

function enforceEnd() {
  if (state.value !== "playing" && state.value !== "paused") return;
  if (duration.value > 0 && localProgress() >= duration.value - 0.001) reachEnd();
}

// The external audio track may run past the main video, so the end is enforced here instead of waiting for "ended".
function reachEnd() {
  const run = current;
  if (!run || run.terminated) return;
  mediaElement.value?.pause();
  run.hls?.stopLoad();
  run.loadStopped = true;
  localTime.value = duration.value;
  state.value = "ended";
  clearInterval(run.endTimer);
  run.endTimer = 0;
}

function resumeLoading(run: PreviewRun) {
  if (!run.loadStopped || !run.hls) return;
  run.loadStopped = false;
  run.hls.startLoad(-1);
}

function armEndChecks(run: PreviewRun) {
  clearInterval(run.endTimer);
  run.endTimer = window.setInterval(() => {
    if (!live(run) || state.value !== "playing") return;
    localTime.value = localProgress();
    enforceEnd();
  }, 100);
}

function onTimeUpdate() {
  if (!current || current.terminated) return;
  if (state.value === "playing") localTime.value = localProgress();
  enforceEnd();
}

function onSeeking() {
  const run = current;
  const media = mediaElement.value;
  if (!run || run.terminated || !media || duration.value <= 0) return;
  const clamped = Math.min(duration.value, Math.max(0, media.currentTime - run.origin));
  const target = run.origin + clamped;
  if (Math.abs(media.currentTime - target) > 0.01) media.currentTime = target;
  localTime.value = clamped;
  enforceEnd();
}

function onPlay() {
  const run = current;
  if (!run || run.terminated) return;
  if (state.value === "playing" || state.value === "paused") { state.value = "playing"; armEndChecks(run); }
}

function onPause() {
  const run = current;
  if (!run || run.terminated) return;
  if (state.value === "ended" || state.value === "failed" || state.value === "preparing") return;
  state.value = "paused";
  clearInterval(run.endTimer);
  run.endTimer = 0;
  localTime.value = localProgress();
}

function handleHlsError(run: PreviewRun, Hls: HlsConstructor, data: any) {
  if (!live(run) || !data?.fatal) return;
  const status = data?.response?.code;
  if (status === 401 || status === 403) { terminate(run, `媒体请求被拒绝（${status}），无法预览此资源。`); return; }
  if (data.details === Hls.ErrorDetails.KEY_LOAD_ERROR) {
    terminate(run, run.snapshot.keyOverride?.kind === "url" ? "无法获取密钥 URL：预览请求不带登录信息，需要登录的密钥请直接下载。" : "无法获取或解析 AES 密钥，预览已停止。");
    return;
  }
  if (data.details === Hls.ErrorDetails.INTERNAL_EXCEPTION) { terminate(run, "预览解码失败，此浏览器可能不支持该媒体格式。"); return; }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && run.networkRecoveries < 1) { run.networkRecoveries += 1; run.hls?.startLoad(); return; }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && run.mediaRecoveries < 1) { run.mediaRecoveries += 1; run.hls?.recoverMediaError(); return; }
  terminate(run, "预览加载失败，可尝试重新播放或改用下载。");
}

function waitForManifest(run: PreviewRun, Hls: HlsConstructor): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (ok: boolean, error?: Error) => {
      if (!run.wait) return;
      run.wait = null;
      run.hls?.off(Hls.Events.MANIFEST_PARSED, done);
      run.hls?.off(Hls.Events.ERROR, failWait);
      if (ok) resolve(); else reject(error ?? new Error(STALE));
    };
    const done = () => settle(true);
    const failWait = (_event: unknown, data: any) => { if (data?.fatal) settle(false, new Error("预览加载失败，可尝试重新播放或改用下载。")); };
    run.wait = { settle };
    run.hls!.on(Hls.Events.MANIFEST_PARSED, done);
    run.hls!.on(Hls.Events.ERROR, failWait);
  });
}

function startSession(snapshot: HlsSelectionSnapshot) {
  const sessionId = crypto.randomUUID();
  const run: PreviewRun = { snapshot, sessionId, previewSessionId: `preview-${sessionId}`, session: null, hls: null, deadlineTimer: 0, endTimer: 0, wait: null, terminated: false, loadStopped: false, origin: 0, networkRecoveries: 0, mediaRecoveries: 0 };
  terminate(current);
  current = run;
  localTime.value = 0;
  error.value = "";
  notice.value = "";
  audioTail.value = false;
  duration.value = Math.max(0, snapshot.selection.actualEnd - snapshot.selection.actualStart);
  state.value = "preparing";
  // The deadline covers preparation only and is not reset by Hls recovery attempts.
  run.deadlineTimer = window.setTimeout(() => {
    if (live(run) && state.value === "preparing") terminate(run, "预览准备超时，请重试或改用下载。");
  }, PREPARE_TIMEOUT_MS);
  queueMicrotask(() => {
    if (!live(run)) return;
    // Runs after mount; the sticky download bar can otherwise cover the player in a short window.
    root.value?.scrollIntoView?.({ block: "nearest" });
    void prepareRun(run);
  });
}

async function prepareRun(run: PreviewRun) {
  try {
    const track = run.snapshot.audioTrack;
    const audioManifest = track ? await props.loadTrack(track, { restrictOrigin: true }) : null;
    if (!live(run)) throw new Error(STALE);
    const plan = await buildHlsPlan(planSelectionFor(run.snapshot, { audioManifest, container: run.snapshot.output.container }));
    if (!live(run)) throw new Error(STALE);
    duration.value = Math.max(0, plan.duration);
    if (audioManifest) {
      try {
        const audioWindow = deriveMediaPlaylist(audioManifest, ...segmentRangeForTime(audioManifest, plan.range.actualStart, plan.range.actualEnd));
        audioTail.value = audioWindow.actualEnd > plan.range.actualEnd + 0.01;
      } catch { audioTail.value = false; }
    }
    await applyPreviewHeaders(run);
    const variant = run.snapshot.variant;
    run.session = createSelectionPreviewSession({
      sessionId: run.sessionId,
      video: plan.videoManifest,
      audio: plan.audioManifest,
      variant: { bandwidth: variant?.bandwidth ?? null, averageBandwidth: variant?.averageBandwidth ?? null, width: variant?.width ?? null, height: variant?.height ?? null, codecs: variant?.codecs ?? null, audioGroup: variant?.audioGroup ?? null },
      keyOverride: run.snapshot.keyOverride
    });
    const Hls = await loadHls();
    if (!live(run)) throw new Error(STALE);
    if (!Hls.isSupported()) throw new Error("当前浏览器不支持此 HLS 预览，可改用下载。");
    const media = mediaElement.value;
    if (!media) throw new Error("预览媒体元素不可用");
    media.muted = muted.value;
    media.volume = volume.value;
    run.hls = new Hls({ ...run.session.configFor(Hls.DefaultConfig.loader as never), ...PREVIEW_HLS_CONFIG });
    run.hls.on(Hls.Events.ERROR, (_, data) => handleHlsError(run, Hls, data));
    run.hls.on(Hls.Events.LEVEL_LOADED, (_, data: any) => {
      if (live(run)) run.origin = data?.details?.fragments?.[0]?.start || 0;
    });
    run.hls.attachMedia(media);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("seeking", onSeeking);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", reachEnd);
    run.hls.loadSource(run.session.masterUrl);
    await waitForManifest(run, Hls);
    if (!live(run)) throw new Error(STALE);
    await playRun(run, media);
  } catch (reason: unknown) {
    if (!live(run)) return;
    if (reason instanceof Error && reason.message === STALE) return;
    terminate(run, humanError(reason instanceof Error ? reason.message : "") || "预览准备失败");
  }
}

async function playRun(run: PreviewRun, media: HTMLVideoElement) {
  try {
    resumeLoading(run);
    await media.play();
    if (!live(run)) { if (!current) media.pause(); return; }
    clearDeadline(run);
    state.value = "playing";
    notice.value = "";
    armEndChecks(run);
  } catch (reason: unknown) {
    if (!live(run)) return;
    clearDeadline(run);
    if (isPlayPolicyRejection(reason)) {
      // Keep the prepared media so the next click can start it.
      state.value = "paused";
      notice.value = "浏览器阻止了播放，请点击播放按钮继续。";
      return;
    }
    terminate(run, "预览播放失败，可尝试重新播放或改用下载。");
  }
}

function togglePlay() {
  const run = current;
  const media = mediaElement.value;
  if (!media || !run) return;
  if (state.value === "playing") media.pause();
  else if (state.value === "ended") void replay();
  else if (state.value === "paused") void playRun(run, media);
}

// Replays the prepared session in place; only a failed or released preview is rebuilt.
async function replay() {
  const run = current;
  const media = mediaElement.value;
  if (run?.hls && media && state.value !== "preparing") {
    media.currentTime = run.origin;
    localTime.value = 0;
    state.value = "paused";
    await playRun(run, media);
    return;
  }
  const snapshot = run?.snapshot || props.snapshot;
  if (snapshot) startSession(snapshot);
}

function seekTo(event: Event) {
  const run = current;
  const media = mediaElement.value;
  const target = Number((event.target as HTMLInputElement).value);
  if (!run || run.terminated || !media || !Number.isFinite(target)) return;
  if (state.value === "ended") state.value = "paused";
  const clamped = Math.min(duration.value, Math.max(0, target));
  media.currentTime = run.origin + clamped;
  localTime.value = clamped;
  resumeLoading(run);
  enforceEnd();
}

function toggleMute() {
  muted.value = !muted.value;
  if (mediaElement.value) mediaElement.value.muted = muted.value;
}

function setVolume(event: Event) {
  const value = Math.min(1, Math.max(0, Number((event.target as HTMLInputElement).value)));
  volume.value = Number.isFinite(value) ? value : 1;
  if (mediaElement.value) mediaElement.value.volume = volume.value;
}
</script>

<template>
  <div ref="root" class="selection-preview" role="region" aria-label="所选范围预览">
    <div class="expanded-preview">
      <video ref="mediaElement" playsinline preload="auto" :poster="poster || undefined"></video>
      <div v-if="state === 'preparing'" class="preview-status"><i></i><strong>正在准备预览媒体</strong><span>只加载所选范围内的切片</span></div>
      <button v-else-if="state === 'idle'" class="preview-play" type="button" :disabled="canStart === false" @click="emit('start')"><span><SfIcon name="player-play" :size="20" /></span><strong>播放所选范围</strong></button>
      <button v-else-if="state === 'paused' || state === 'ended'" class="preview-play" type="button" @click="togglePlay"><span><SfIcon :name="state === 'ended' ? 'refresh' : 'player-play'" :size="20" /></span><strong>{{ state === 'ended' ? '从头重播' : '继续播放' }}</strong></button>
    </div>
    <div v-if="error" class="status-banner error" role="alert">{{ error }}</div>
    <div v-else-if="notice" class="status-banner warning" role="status">{{ notice }}</div>
    <div v-if="audioTail" class="status-banner warning" role="note">外置音轨比主视频长，预览在主视频终点停止；下载文件可能保留更长的音轨尾部。</div>
    <div v-if="state !== 'idle'" class="preview-controls">
      <button class="icon-button" type="button" :aria-label="state === 'playing' ? '暂停' : state === 'ended' ? '重播' : '播放'" :disabled="state === 'preparing' || state === 'failed'" @click="togglePlay"><SfIcon :name="state === 'playing' ? 'player-pause' : 'player-play'" /></button>
      <button class="icon-button" type="button" aria-label="重新播放" :disabled="state === 'preparing' || !snapshot" @click="replay"><SfIcon name="refresh" /></button>
      <label class="preview-seek"><span class="sr-only">播放进度</span><input type="range" min="0" :max="Math.max(duration, 0.1)" step="0.1" :value="localTime" :disabled="!canSeek" @input="seekTo"></label>
      <span class="preview-time">{{ formatDuration(localTime) }} / {{ formatDuration(duration) }}</span>
      <button class="icon-button" type="button" :aria-label="muted ? '取消静音' : '静音'" :aria-pressed="muted" @click="toggleMute"><SfIcon :name="muted ? 'volume-off' : 'volume'" /></button>
      <label class="preview-volume"><span class="sr-only">音量</span><input type="range" min="0" max="1" step="0.05" :value="volume" @input="setVolume"></label>
      <span class="tag">{{ STATE_LABELS[state] }}</span>
    </div>
  </div>
</template>
