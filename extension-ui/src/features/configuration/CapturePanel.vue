<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from "vue";
import type { UiContext } from "../../types";
import type { CaptureSnapshot } from "../../../../shared/capture";
import { createCaptureState } from "../capture/state";
import { sessionError } from "../session-client";
import { configurationRequest } from "./client";
import { readSettings } from "../settings/state";
import SfIcon from "../../ui/SfIcon.vue";
import SfSelect from "../../ui/SfSelect.vue";
import SfDialog from "../../ui/SfDialog.vue";
const props = defineProps<{ context: UiContext | null; targetObjectUrl?: string }>();
const { lastSession, restartPhase, orderedSessions, failedSessions, phase, quickCandidate, remove, removeFailed, catalog, error, message, busy, selected, acknowledged, directory, active, selectionLocked, blobUnconfirmed, sourceKey, scan, start, stop, recover, refresh, restarting, renewed, restart, replay } = createCaptureState(toRef(props, "context"), true, toRef(props, "targetObjectUrl"));
const labels: Record<string, string> = { armed: "等待数据", capturing: "录制中", stopping: "正在停止", finalizing: "正在生成文件", complete: "已保存", partial: "未完成", interrupted: "已中断", unavailable: "记录损坏" };
const sourceOptions = computed(() => [{ value: "", label: props.targetObjectUrl ? "尚未定位对应媒体源" : "请选择媒体源" }, ...catalog.value.sources.map(source => ({ value: sourceKey(source), label: `${source.frameId === 0 ? "主页面" : `框架 ${source.frameId}`} · 媒体源 ${source.id} · ${source.url} · ${source.tracks.join(", ")} · ${source.state}` }))]);
const steps = [{ key: "ready", label: "勾选授权，点一键捕捉" }, { key: "waiting", label: "到来源页播放视频" }, { key: "recording", label: "录制中，播完自动保存" }, { key: "saving", label: "生成视频文件" }];
const stepIndex = computed(() => phase.value === "done" ? steps.length : phase.value === "failed" ? 0 : steps.findIndex(step => step.key === phase.value));
const guidance = computed(() => {
  if (phase.value === "waiting") return restartPhase.value === "claimed" ? "来源页已加载。如果视频没有自动播放，请切到来源页点击播放，录制会自动开始。" : "来源页正在重新加载，快慢取决于网速和网站，请稍等。视频如果自动播放，录制会自动开始。";
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
const pendingDelete = ref<CaptureSnapshot | null>(null);
const pendingCleanup = ref(false);
const notice = ref("");
const finished = (session: CaptureSnapshot) => ["complete", "partial", "interrupted"].includes(session.state);
function failure(session: CaptureSnapshot) { return session.outputs.length ? `已生成的文件可能不完整。原因：${sessionError(session.error)}` : sessionError(session.error); }
function title(session: CaptureSnapshot) { return session.pageTitle || hostOf(session.pageUrl || session.source?.url) || "未知页面"; }
function hostOf(url?: string) { try { return url ? new URL(url).hostname : ""; } catch { return ""; } }
function when(session: CaptureSnapshot) { return session.createdAt ? new Date(session.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""; }
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
async function copyPath(path: string) {
  try { await navigator.clipboard.writeText(path); notice.value = "已复制文件路径。"; }
  catch { notice.value = "复制失败，请手动选中路径复制。"; }
}
async function confirmDelete() { const session = pendingDelete.value; pendingDelete.value = null; if (session) await remove(session.id); }
async function confirmCleanup() { pendingCleanup.value = false; await removeFailed(); }
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
      <p class="capture-guidance" role="status" :data-tone="phase === 'done' ? 'success' : phase === 'failed' ? 'danger' : undefined">{{ guidance }}</p>
      <label class="feature-check"><input v-model="acknowledged" type="checkbox">我有权保存此视频，并了解只能录到开始之后播放的内容</label>
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
          <div class="capture-source-row"><div class="field"><span>媒体源</span><SfSelect v-model="selected" :options="sourceOptions" label="媒体源" :disabled="busy || !!active || selectionLocked" /></div><button class="button" :disabled="busy || !context?.supported || !!active" @click="scan"><SfIcon name="radar-2" /><span>扫描媒体源</span></button></div>
          <p v-for="frame in catalog.frames.filter(item => item.state !== 'ready' && item.state !== 'unsupported')" :key="frame.frameId" class="feature-note">框架 {{ frame.frameId }} · {{ frame.url }}：{{ sessionError(frame.error) }}</p>
          <label class="field"><span>保存目录（留空使用设置中的保存目录）</span><input v-model="directory" class="control" :disabled="busy || !!active" :placeholder="defaultDirectory || fallbackDirectory"></label>
          <div class="feature-row"><button class="button" :disabled="busy || restarting || !context?.supported || !selected || !acknowledged || !!active" @click="start()"><SfIcon name="capture" /><span>开始捕捉</span></button><button class="button" :disabled="busy || !active || !['armed', 'capturing'].includes(active.state)" @click="replay"><SfIcon name="player-play" /><span>从头捕获</span></button><button class="button ghost" @click="refresh"><SfIcon name="refresh" /><span>刷新会话</span></button></div>
        </div>
      </details>
    </section>
    <p v-if="message" class="feature-message" role="status">{{ message }}</p><p v-if="notice" class="feature-message" role="status">{{ notice }}</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <header v-if="orderedSessions.length" class="capture-records-head"><h4>录制记录 <small>{{ orderedSessions.length }} 条，最新的在上</small></h4><button v-if="failedSessions.length" class="button sm" :disabled="busy" @click="pendingCleanup = true"><SfIcon name="trash" /><span>清理失败记录</span></button></header>
    <article v-for="session in orderedSessions" :key="session.id" class="feature-rule capture-session" :class="{ latest: session.id === lastSession?.id }">
      <div class="dispatch-item-head"><span class="dispatch-state" :data-state="session.state">{{ labels[session.state] || session.state }}</span><strong class="capture-session-title" :title="session.pageUrl || session.source?.url">{{ title(session) }}</strong><small class="capture-session-meta">{{ when(session) }}<template v-if="session.state !== 'unavailable'"> · {{ (session.bytes / 1048576).toFixed(1) }} MiB</template></small></div>
      <p v-if="session.ended && session.state === 'complete'" class="feature-note">视频已播放到结尾。</p>
      <div v-for="output in session.outputs" :key="output" class="capture-output-row"><p class="capture-output">{{ output }}</p><button class="button sm" type="button" @click="copyPath(output)"><SfIcon name="copy" /><span>复制路径</span></button></div>
      <p v-if="session.error" class="inline-error">{{ failure(session) }}</p>
      <details v-if="session.tracks.length" class="capture-tracks"><summary>技术信息</summary><p v-for="track in session.tracks" :key="track.id" class="feature-note">轨道 {{ track.id }} · {{ track.mime }} · {{ track.initialized ? '含初始化片段' : '缺少初始化片段' }}</p></details>
      <div v-if="finished(session)" class="feature-row">
        <button v-if="['partial', 'interrupted'].includes(session.state)" class="button sm" :disabled="busy" @click="recover(session.id)"><SfIcon name="refresh" /><span>重新生成文件</span></button>
        <button class="button sm danger-ghost" :disabled="busy" @click="pendingDelete = session"><SfIcon name="trash" /><span>删除</span></button>
      </div>
    </article>
    <SfDialog v-if="pendingDelete" title="删除这条录制记录？" size="sm" @close="pendingDelete = null">
      <p>{{ pendingDelete.outputs.length ? "已保存的视频文件会一起删除，无法恢复。" : "录到的原始数据会一起删除，无法恢复。" }}</p>
      <template #footer><button class="button" type="button" @click="pendingDelete = null">取消</button><button class="button danger-solid" type="button" @click="confirmDelete">删除</button></template>
    </SfDialog>
    <SfDialog v-if="pendingCleanup" title="清理失败记录？" size="sm" @close="pendingCleanup = false">
      <p>将删除 {{ failedSessions.length }} 条未完成或已中断的记录及其原始数据。已保存的视频不受影响。</p>
      <template #footer><button class="button" type="button" @click="pendingCleanup = false">取消</button><button class="button danger-solid" type="button" @click="confirmCleanup">清理</button></template>
    </SfDialog>
  </section>
</template>
