<script setup lang="ts">
import { vModalFocus } from "../modal-focus";
import { computed, reactive, ref } from "vue";
import type { DownloadTask } from "../types";
import { formatBytes, formatSpeed } from "../format";
import { validateHlsKeyOverride, type HlsKeyOverrideKind } from "../media";

const props = defineProps<{ tasks: DownloadTask[]; sourceTasks: DownloadTask[]; connected?: boolean }>();
const emit = defineEmits<{ control: [task: DownloadTask, action: string, context?: any]; delete: [task: DownloadTask, deleteFile: boolean] }>();
const scope = ref<"current" | "all">("current");
const expanded = ref(new Set<string>());
const pendingDelete = ref<DownloadTask | null>(null);
const deleteStage = ref<"choice" | "confirm">("choice");
const deleteFile = ref(false);
const resumeTask = ref<DownloadTask | null>(null);
const resumeKey = reactive<{ kind: HlsKeyOverrideKind; value: string; iv: string }>({ kind: "hex", value: "", iv: "" });
const resumeKeyError = computed(() => resumeTask.value ? validateHlsKeyOverride(resumeKey.kind, resumeKey.value, resumeKey.iv) : "");
const activeStates = new Set(["queued", "starting", "running", "retrying", "pausing", "cancelling", "stopping"]);
const visible = computed(() => scope.value === "current" ? props.sourceTasks : props.tasks);

function isActive(task: DownloadTask) { return activeStates.has(task.state); }
function stateLabel(task: DownloadTask) {
  const labels: Record<string, string> = { queued: "等待下载", starting: task.phase === "validating_key" ? "正在验证密钥" : "正在连接", running: task.phase === "recording" ? "正在录制直播" : task.phase === "downloading_segments" ? "正在下载切片" : task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "正在无转码合并" : "正在下载", retrying: "正在恢复", pausing: "正在暂停", paused: "已暂停", cancelling: "正在取消", stopping: "正在停止并保存", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", partial: "部分输出失败", interrupted: task.resume_requirement ? "等待用户恢复" : "已中断" };
  return labels[task.state] || task.message || task.state;
}
function toggle(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next; }
function openDelete(task: DownloadTask) { pendingDelete.value = task; deleteStage.value = "choice"; }
function choose(value: boolean) { deleteFile.value = value; deleteStage.value = "confirm"; }
function confirmDelete() { if (pendingDelete.value) emit("delete", pendingDelete.value, deleteFile.value); pendingDelete.value = null; }
function resumeLabel(task: DownloadTask) {
  if (task.resume_requirement?.includes("authorization") && task.resume_requirement.includes("key")) return "重新授权、输入密钥并继续";
  return task.resume_requirement?.includes("authorization") ? "重新授权并继续" : task.resume_requirement?.includes("key") ? "输入密钥并继续" : "继续";
}
function resumeNotice(task: DownloadTask) {
  if (task.resume_requirement === "dash_reparse_required") return "请回到资源页重新解析 DASH 并创建任务";
  if (task.resume_requirement?.includes("authorization") && task.resume_requirement.includes("key")) return "需要来源页面重新授权并重新输入自定义密钥";
  return task.resume_requirement?.includes("authorization") ? "需要来源页面重新授权" : "需要重新输入自定义密钥";
}
function requestResume(task: DownloadTask) {
  if (task.resume_requirement?.includes("key")) { resumeTask.value = task; resumeKey.value = ""; resumeKey.iv = ""; return; }
  emit("control", task, "resume");
}
function confirmResume() {
  if (!resumeTask.value || resumeKeyError.value) return;
  emit("control", resumeTask.value, "resume", { keyOverride: { kind: resumeKey.kind, value: resumeKey.value.trim(), iv: resumeKey.iv.trim() || null } });
  resumeTask.value = null;
}
</script>

<template>
  <section class="downloads-page panel">
    <div class="panel-title downloads-title"><div><h2>下载任务</h2><p>查看当前页面或所有来源创建的任务</p></div><div class="segmented"><button :class="{ active: scope === 'current' }" @click="scope = 'current'">当前页面 <b>{{ sourceTasks.length }}</b></button><button :class="{ active: scope === 'all' }" @click="scope = 'all'">全部任务 <b>{{ tasks.length }}</b></button></div></div>
    <div class="task-list">
      <article v-for="task in [...visible].reverse()" :key="task.id" class="task-card" :class="{ active: isActive(task), expanded: expanded.has(task.id) || isActive(task) }">
        <button class="task-summary" type="button" @click="toggle(task.id)"><span class="task-state-icon" :data-state="task.state">{{ task.live_recording && isActive(task) ? '●' : task.state === 'succeeded' ? '✓' : task.state === 'failed' || task.state === 'partial' ? '!' : task.state === 'paused' ? 'Ⅱ' : '↓' }}</span><span class="task-main"><strong>{{ task.title }}</strong><small>{{ stateLabel(task) }}<template v-if="task.output"> · {{ task.output }}</template></small></span><span class="task-percent">{{ task.live_recording && isActive(task) ? 'LIVE' : `${task.progress || 0}%` }}</span><span class="row-arrow">⌄</span></button>
        <div v-if="expanded.has(task.id) || isActive(task)" class="task-detail">
          <div class="progress-track" :class="{ live: task.live_recording && task.phase === 'recording' }"><i :style="{ width: task.live_recording && task.phase === 'recording' ? '36%' : `${Math.max(0, Math.min(100, task.progress || 0))}%` }"></i></div>
          <div class="task-metrics"><span>{{ formatBytes(task.downloaded_bytes) }}<template v-if="task.total_bytes"> / {{ formatBytes(task.total_bytes) }}</template></span><span>{{ formatSpeed(task.speed_bytes_per_second) }}</span><span v-if="task.live_recording && task.recorded_duration">已录制 {{ Math.floor(task.recorded_duration / 60) }}分{{ Math.floor(task.recorded_duration % 60) }}秒</span><span v-if="task.last_media_sequence != null">媒体序列 #{{ task.last_media_sequence }}</span><span v-if="task.segments_total">切片 {{ task.segments_completed || 0 }}/{{ task.segments_total }}</span><span v-if="task.retry_count">累计重试 {{ task.retry_count }} 次</span><span v-if="task.failed_segments" class="metric-danger">失败 {{ task.failed_segments }} 个</span><span v-if="task.eta_seconds != null">剩余约 {{ task.eta_seconds }} 秒</span><span>{{ task.message || stateLabel(task) }}</span></div>
          <div v-if="task.outputs?.length" class="task-outputs"><div v-for="(output, index) in task.outputs" :key="index"><span class="tag">{{ output.kind === 'media' ? '视频' : output.language || '字幕' }}</span><strong>{{ output.path || '等待生成文件' }}</strong><em :data-state="output.state">{{ output.state === 'succeeded' ? '已完成' : output.state === 'failed' ? '失败' : '处理中' }}</em></div></div>
          <div v-if="task.resume_requirement" class="resume-notice"><strong>{{ resumeNotice(task) }}</strong><span v-if="task.resume_requirement !== 'dash_reparse_required'">已完成切片和检查点会保留，不会从头下载。</span></div>
          <fieldset class="task-actions" :disabled="connected === false"><button v-if="task.live_recording && ['queued','starting','running','retrying','paused','interrupted'].includes(task.state)" class="button primary" @click="$emit('control', task, 'stop')">停止并保存</button><button v-if="isActive(task) && task.state !== 'pausing' && task.state !== 'stopping'" class="button" @click="$emit('control', task, 'pause')">暂停</button><button v-if="task.resume_requirement !== 'dash_reparse_required' && (task.state === 'paused' || (task.state === 'interrupted' && Boolean(task.resume_requirement)))" class="button primary" @click="requestResume(task)">{{ resumeLabel(task) }}</button><button v-if="['failed','cancelled','interrupted','partial'].includes(task.state) && !task.resume_requirement" class="button" @click="$emit('control', task, 'retry')">重试</button><button v-if="isActive(task) || task.state === 'paused'" class="button" @click="$emit('control', task, 'cancel')">取消</button><button class="button danger-outline" @click="openDelete(task)">删除</button></fieldset>
        </div>
      </article>
      <div v-if="!visible.length" class="empty-state"><span>↓</span><h3>{{ scope === 'current' ? '当前页面还没有下载任务' : '暂无下载任务' }}</h3><p>从资源页选择媒体并开始下载后，任务会显示在这里。</p></div>
    </div>
    <Transition name="fade"><div v-if="pendingDelete" class="dialog-backdrop" @click.self="pendingDelete = null"><section v-modal-focus="() => { pendingDelete = null; resumeTask = null; }" class="dialog" role="dialog" aria-modal="true"><div class="dialog-heading"><div><h2>{{ deleteStage === 'choice' ? '删除下载任务' : '再次确认删除' }}</h2><p>{{ pendingDelete.title }}</p></div><button class="icon-button" @click="pendingDelete = null">×</button></div><template v-if="deleteStage === 'choice'"><div class="delete-choices"><button @click="choose(false)"><strong>仅删除任务记录</strong><span>保留已经下载到本地的文件</span></button><button class="danger-choice" @click="choose(true)"><strong>删除记录和本地文件</strong><span>同时删除该任务产生的视频及字幕文件</span></button></div></template><template v-else><div class="confirm-warning"><b>!</b><div><strong>{{ deleteFile ? '确认永久删除任务和全部本地文件？' : '确认只删除任务记录？' }}</strong><p>{{ deleteFile ? '此操作无法撤销。主视频和附属字幕文件都会被删除。' : '本地文件将继续保留。' }}</p></div></div><div class="dialog-actions"><button class="button" @click="deleteStage = 'choice'">返回</button><button class="button danger-solid" @click="confirmDelete">确认删除</button></div></template></section></div></Transition>
    <Transition name="fade"><div v-if="resumeTask" class="dialog-backdrop" @click.self="resumeTask = null"><section v-modal-focus="() => { pendingDelete = null; resumeTask = null; }" class="dialog" role="dialog" aria-modal="true"><div class="dialog-heading"><div><h2>重新输入 AES-128 密钥</h2><p>{{ resumeTask.title }}</p></div><button class="icon-button" @click="resumeTask = null">×</button></div><div class="resume-key-form"><label><span>密钥格式</span><select v-model="resumeKey.kind" class="control"><option value="hex">Hex</option><option value="base64">Base64</option><option value="url">密钥 URL</option></select></label><label><span>{{ resumeKey.kind === 'url' ? '密钥地址' : '密钥内容' }}</span><input v-model="resumeKey.value" class="control" autocomplete="off"></label><label><span>自定义 IV（可选）</span><input v-model="resumeKey.iv" class="control" autocomplete="off" placeholder="32 位十六进制"></label><p v-if="resumeKeyError" class="inline-error">{{ resumeKeyError }}</p><p class="privacy-hint">密钥只用于本次恢复，不会写入任务记录或检查点。</p></div><div class="dialog-actions"><button class="button" @click="resumeTask = null">取消</button><button class="button primary" :disabled="Boolean(resumeKeyError)" @click="confirmResume">验证并继续</button></div></section></div></Transition>
  </section>
</template>
