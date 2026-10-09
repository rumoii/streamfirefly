<script setup lang="ts">
import { computed, ref } from "vue";
import type { CaptureSnapshot } from "../../../../shared/capture";
import { folderOf } from "../../format";
import { sessionError, sessionRequest } from "../session-client";
import { CAPTURE_STATE_LABELS, captureTitle, codecHint, isFinishedCapture } from "./display";
import SfIcon from "../../ui/SfIcon.vue";
import SfDialog from "../../ui/SfDialog.vue";

const props = defineProps<{ sessions: CaptureSnapshot[]; busy?: boolean; latestId?: string; heading?: boolean }>();
const emit = defineEmits<{ recover: [id: string]; remove: [id: string]; removeFailed: [] }>();
const failedSessions = computed(() => props.sessions.filter(session => ["partial", "interrupted"].includes(session.state)));
const pendingDelete = ref<CaptureSnapshot | null>(null);
const pendingCleanup = ref(false);
const notice = ref("");

function failure(session: CaptureSnapshot) { return session.outputs.length ? `已生成的文件可能不完整。原因：${sessionError(session.error)}` : sessionError(session.error); }
function when(session: CaptureSnapshot) { return session.createdAt ? new Date(session.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""; }
// Users open the folder themselves and play the file from there, so copy its directory.
async function copyFolder(path: string) {
  try { await navigator.clipboard.writeText(folderOf(path)); notice.value = "已复制文件夹路径。"; }
  catch { notice.value = "复制失败，请手动选中路径复制。"; }
}
async function revealOutput(session: CaptureSnapshot, path: string) {
  try { await sessionRequest("capture.reveal", { id: session.id, path }); notice.value = ""; }
  catch (reason) { notice.value = reason instanceof Error && reason.message === "unsupported_message" ? "本地助手版本较旧，更新后才能直接打开文件夹；可以先用“复制文件夹路径”。" : sessionError(reason); }
}
function confirmDelete() { const session = pendingDelete.value; pendingDelete.value = null; if (session) emit("remove", session.id); }
function confirmCleanup() { pendingCleanup.value = false; emit("removeFailed"); }
</script>

<template>
  <header v-if="heading && sessions.length" class="capture-records-head"><h4>录制记录 <small>{{ sessions.length }} 条，最新的在上</small></h4><button v-if="failedSessions.length" class="button sm" :disabled="busy" @click="pendingCleanup = true"><SfIcon name="trash" /><span>清理失败记录</span></button></header>
  <p v-if="notice" class="feature-message" role="status">{{ notice }}</p>
  <article v-for="session in sessions" :key="session.id" class="feature-rule capture-session" :class="{ latest: session.id === latestId, busy: ['capturing', 'finalizing'].includes(session.state) }">
    <div class="dispatch-item-head"><span class="dispatch-state" :data-state="session.state">{{ CAPTURE_STATE_LABELS[session.state] || session.state }}</span><strong class="capture-session-title" :title="session.pageUrl || session.source?.url">{{ captureTitle(session) }}</strong><small class="capture-session-meta">{{ when(session) }}<template v-if="session.state !== 'unavailable'"> · {{ (session.bytes / 1048576).toFixed(1) }} MiB</template></small></div>
    <p v-if="session.ended && session.state === 'complete'" class="feature-note">视频已播放到结尾。</p>
    <div v-for="output in session.outputs" :key="output" class="capture-output-row"><p class="capture-output">{{ output }}</p><button class="button sm" type="button" @click="copyFolder(output)"><SfIcon name="copy" /><span>复制文件夹路径</span></button><button class="button sm" type="button" @click="revealOutput(session, output)"><SfIcon name="folder" /><span>打开文件夹</span></button></div>
    <p v-if="session.outputs.length" class="feature-note">{{ codecHint(session) }}</p>
    <p v-if="session.outputs.length > 1" class="feature-note">播放中切换过清晰度或拖动过进度，视频分成了 {{ session.outputs.length }} 段。</p>
    <p v-if="session.error" class="inline-error">{{ failure(session) }}</p>
    <details v-if="session.tracks.length" class="capture-tracks"><summary>技术信息</summary><p v-for="track in session.tracks" :key="track.id" class="feature-note">轨道 {{ track.id }} · {{ track.mime }} · {{ track.initialized ? '含初始化片段' : '缺少初始化片段' }}</p></details>
    <div v-if="isFinishedCapture(session)" class="feature-row">
      <button v-if="['partial', 'interrupted'].includes(session.state)" class="button sm" :disabled="busy" @click="emit('recover', session.id)"><SfIcon name="refresh" /><span>重新生成文件</span></button>
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
</template>
