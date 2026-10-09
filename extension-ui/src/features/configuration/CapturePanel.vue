<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from "vue";
import type { UiContext } from "../../types";
import type { CaptureSnapshot } from "../../../../shared/capture";
import { CAPTURE_SPEEDS, createCaptureState } from "../capture/state";
import { sessionError } from "../session-client";
import { configurationRequest } from "./client";
import { readSettings } from "../settings/state";
import SfIcon from "../../ui/SfIcon.vue";
import SfSelect from "../../ui/SfSelect.vue";
import CaptureRecordList from "../capture/CaptureRecordList.vue";
import { modernCodec } from "../capture/display";
const props = defineProps<{ context: UiContext | null; targetObjectUrl?: string }>();
const { chooseSource, speed, setSpeed, compatibleCodecs, setCompatibleCodecs, lastSession, restartPhase, orderedSessions, phase, quickCandidate, remove, removeFailed, catalog, error, message, busy, selected, acknowledged, directory, active, selectionLocked, blobUnconfirmed, sourceKey, scan, start, stop, recover, refresh, restarting, renewed, restart, replay } = createCaptureState(toRef(props, "context"), true, toRef(props, "targetObjectUrl"));
const speedOptions = CAPTURE_SPEEDS.map(value => ({ value, label: value === "1" ? "正常速度" : `${value} 倍速（静音）` }));
const sourceOptions = computed(() => [{ value: "", label: props.targetObjectUrl ? "尚未定位对应媒体源" : "请选择媒体源" }, ...catalog.value.sources.map(source => ({ value: sourceKey(source), label: `${source.frameId === 0 ? "主页面" : `框架 ${source.frameId}`} · 媒体源 ${source.id} · ${source.url} · ${source.tracks.join(", ")} · ${source.state}` }))]);
const steps = [{ key: "ready", label: "勾选授权，点一键捕捉" }, { key: "waiting", label: "到来源页播放视频" }, { key: "recording", label: "录制中，播完自动保存" }, { key: "saving", label: "生成视频文件" }];
const stepIndex = computed(() => phase.value === "done" ? steps.length : phase.value === "failed" ? 0 : steps.findIndex(step => step.key === phase.value));
const guidance = computed(() => {
  if (phase.value === "waiting") return restartPhase.value === "claimed" ? "来源页已加载。如果视频没有自动播放，请切到来源页点击播放，录制会自动开始。" : "来源页正在重新加载，快慢取决于网速和网站，请稍等。视频如果自动播放，录制会自动开始。";
  if (phase.value === "recording" && active.value?.paused) return `已收到 ${((active.value.bytes || 0) / 1048576).toFixed(1)} MiB，但来源页的视频暂停了，录不到新内容。请点“去来源页播放”，在来源页继续播放。`;
  if (phase.value === "recording") return `正在录制，已收到 ${((active.value?.bytes || 0) / 1048576).toFixed(1)} MiB。让视频播放到结尾会自动保存，也可以随时点“停止并保存”。`;
  if (phase.value === "saving") return "正在生成视频文件，请稍等。";
  if (phase.value === "done") return `录制完成，视频已保存${lastSession.value?.outputs.length ? `：${lastSession.value.outputs[0]}` : ""}。可以在下方录制记录里复制路径。`;
  if (phase.value === "failed") return lastSession.value?.outputs.length ? `这次录制没有完整结束，已录到的部分已保存：${lastSession.value.outputs[0]}。${failure(lastSession.value)}` : `这次录制没有成功：${sessionError(lastSession.value?.error || "capture_disconnected")}`;
  return acknowledged.value ? "点“一键捕捉”后，来源页会自动刷新并从头录制。" : "先勾选下面的授权说明，再点“一键捕捉”。";
});
const fallbackDirectory = "%LOCALAPPDATA%\\StreamFirefly\\captures", defaultDirectory = ref("");
onMounted(async () => { try { defaultDirectory.value = (await readSettings()).saveDir.trim(); } catch { defaultDirectory.value = ""; } });
const advancedOpen = ref(false);
watch(() => [blobUnconfirmed.value, renewed.value && !restarting.value && !active.value && catalog.value.sources.length > 1], needs => { if (needs.some(Boolean)) advancedOpen.value = true; });
const notice = ref("");
function failure(session: CaptureSnapshot) { return session.outputs.length ? `已生成的文件可能不完整。原因：${sessionError(session.error)}` : sessionError(session.error); }
async function openQuickDownload() {
  if (!props.context || !quickCandidate.value) return;
  try { await configurationRequest("ui.source.activate", { tabId: props.context.sourceTabId, closeCurrent: false, candidateId: quickCandidate.value.id }); notice.value = ""; }
  catch (reason) { notice.value = reason instanceof Error && reason.message !== "source_tab_unavailable" ? reason.message : "来源标签页已关闭。"; }
}
async function returnToSource() {
  if (!props.context) return;
  try { await configurationRequest("ui.source.activate", { tabId: props.context.sourceTabId, closeCurrent: false }); notice.value = ""; }
  catch { notice.value = "来源标签页已关闭。"; }
}
const liveCodecNotice = computed(() => {
  const codec = active.value ? modernCodec(active.value) : "";
  if (!codec) return "";
  return compatibleCodecs.value
    ? `这个网站没有按兼容格式提供视频，录到的是 ${codec}。可以继续录，录完用 VLC 或 PotPlayer 播放，或在微软商店安装对应的视频扩展。`
    : `当前录到的是 ${codec}，Windows 自带播放器打不开。想要能直接播放的文件，请使用支持的应用程序或者请勾选“优先录制兼容格式”后重新一键捕捉。`;
});
defineExpose({ scan });
</script>
<template>
  <section class="feature-panel capture-panel">
    <section v-if="quickCandidate" class="capture-quick">
      <div><strong>这个页面有可以直接下载的视频</strong><p>直接下载比录制更快、画质完整，建议优先使用。</p></div>
      <button class="button primary" type="button" @click="openQuickDownload"><SfIcon name="download" /><span>去快速下载</span></button>
    </section>
    <section class="feature-card">
      <h4>录制视频</h4>
      <p class="feature-note">适合无法直接下载的视频。一键捕捉会刷新来源页，从头开始录制，视频播完自动保存。</p>
      <ol class="capture-steps">
        <li v-for="(step, index) in steps" :key="step.key" :data-state="index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'todo'"><i>{{ index < stepIndex ? '✓' : index + 1 }}</i><span>{{ step.label }}</span></li>
      </ol>
      <p class="capture-guidance" role="status" :data-tone="phase === 'done' ? 'success' : phase === 'failed' ? 'danger' : phase === 'recording' && active?.paused ? 'warning' : undefined">{{ guidance }}</p>
      <div class="capture-speed-row"><div class="field"><span>录制速度</span><SfSelect :model-value="speed" :options="speedOptions" label="录制速度" @update:model-value="setSpeed" /></div><p class="feature-note">加速时静音播放，长视频不用等它实时播完。网速跟不上时视频会停下来缓冲，不影响录到的内容；部分网站会把速度改回去。建议 2–4 倍。</p></div>
      <p v-if="Number(speed) >= 8" class="tool-notice">倍速太高时，网站可能自动降低清晰度，录出来的视频也可能分成几段。</p>
      <p v-if="liveCodecNotice" class="tool-notice">{{ liveCodecNotice }}</p>
      <p v-if="active?.speedOverridden" class="tool-notice">{{ sessionError("capture_speed_overridden") }}</p>
      <label class="feature-check"><input v-model="acknowledged" type="checkbox">我有权保存此视频，并了解只能录到开始之后播放的内容</label>
      <div class="capture-option">
        <label class="feature-check"><input :checked="compatibleCodecs" type="checkbox" @change="setCompatibleCodecs(($event.target as HTMLInputElement).checked)">一键捕捉时优先录制兼容格式（H.264）</label>
        <p class="feature-note capture-codec-state">{{ compatibleCodecs ? "已开启：网站会优先提供 H.264，录好的视频用系统自带播放器就能直接打开；部分网站的高清晰度只有 AV1/HEVC，清晰度可能会降低。" : "已关闭：保留网站原本的画质和编码（常见 AV1/HEVC），播放时需要支持这些编码的播放器，比如 VLC、PotPlayer，或者在微软商店安装对应的视频扩展。" }}</p>
        <p class="feature-note">怎么选：更看重画质就关掉，用支持的播放器播放；只想下载下来就能直接播，保持开启。</p>
      </div>
      <div class="feature-row capture-actions">
        <button class="button primary large" :disabled="busy || restarting || !context?.supported || !acknowledged || !!active" @click="restart"><SfIcon name="capture" /><span>一键捕捉</span></button>
        <button v-if="phase === 'waiting' || phase === 'recording'" class="button" type="button" @click="returnToSource"><SfIcon name="arrow-back-up" /><span>去来源页播放</span></button>
        <button class="button" :disabled="busy || !active || !['armed', 'capturing'].includes(active.state)" @click="stop"><SfIcon name="player-stop" /><span>停止并保存</span></button>
      </div>
      <details class="capture-advanced" :open="advancedOpen" @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open">
        <summary>高级选项</summary>
        <div class="capture-advanced-body">
          <p class="feature-note">不刷新页面、直接从当前位置录制：会补入页面里已有的视频开头信息，但只能录到开始之后新加载的内容；视频已经缓冲完时录不到东西，请改用一键捕捉。不处理 DRM。</p>
          <p v-if="targetObjectUrl && !renewed" class="tool-notice">正在处理资源列表里的 Blob 临时视频。</p>
          <p v-if="blobUnconfirmed" class="tool-notice">未确认对应此 Blob，将捕捉手动选择的媒体源。</p>
          <div class="capture-source-row"><div class="field"><span>媒体源</span><SfSelect :model-value="selected" :options="sourceOptions" label="媒体源" @update:model-value="chooseSource" :disabled="busy || !!active || selectionLocked" /></div><button class="button" :disabled="busy || !context?.supported || !!active" @click="scan"><SfIcon name="radar-2" /><span>扫描媒体源</span></button></div>
          <p v-for="frame in catalog.frames.filter(item => item.state !== 'ready' && item.state !== 'unsupported')" :key="frame.frameId" class="feature-note">框架 {{ frame.frameId }} · {{ frame.url }}：{{ sessionError(frame.error) }}</p>
          <label class="field"><span>保存目录（留空使用设置中的保存目录）</span><input v-model="directory" class="control" :disabled="busy || !!active" :placeholder="defaultDirectory || fallbackDirectory"></label>
          <div class="feature-row"><button class="button" :disabled="busy || restarting || !context?.supported || !selected || !acknowledged || !!active" @click="start()"><SfIcon name="capture" /><span>开始捕捉</span></button><button class="button" :disabled="busy || !active || !['armed', 'capturing'].includes(active.state)" @click="replay"><SfIcon name="player-play" /><span>从头捕获</span></button><button class="button ghost" @click="refresh"><SfIcon name="refresh" /><span>刷新会话</span></button></div>
        </div>
      </details>
    </section>
    <p v-if="message" class="feature-message" role="status">{{ message }}</p><p v-if="notice" class="feature-message" role="status">{{ notice }}</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <CaptureRecordList :sessions="orderedSessions" :busy="busy" :latest-id="lastSession?.id" heading @recover="recover" @remove="remove" @remove-failed="removeFailed" />
  </section>
</template>
