<script setup lang="ts">
import { computed } from "vue";
import type { DownloadTask } from "../types";
import { formatBytes } from "../format";
import { taskOutputLabel } from "../task-output";
import SfIcon from "../ui/SfIcon.vue";
import SfMenu, { type MenuItem } from "../ui/SfMenu.vue";
import { isActive, isRecording, isWorking, progressText, recordedText, resumeNotice, stateIcon, statusLine, taskActions, type TaskActionKey } from "../features/downloads/display";

const props = defineProps<{ task: DownloadTask; connected?: boolean; compact?: boolean; readonly?: boolean; expanded?: boolean }>();
const emit = defineEmits<{ action: [key: TaskActionKey]; toggle: []; reveal: [path: string]; copyFolder: [path: string] }>();
const actions = computed(() => taskActions(props.task));
const offline = computed(() => props.connected === false);
const menuItems = computed<MenuItem[]>(() => actions.value.menu.map(action => ({ ...action, disabled: offline.value })));
const showProgress = computed(() => isActive(props.task) || props.task.state === "paused");
const progressWidth = computed(() => `${Math.max(0, Math.min(100, props.task.progress || 0))}%`);
const metrics = computed(() => {
  const task = props.task;
  return [
    task.downloaded_bytes ? `${formatBytes(task.downloaded_bytes)}${task.total_bytes ? ` / ${formatBytes(task.total_bytes)}` : ""}` : "",
    task.live_recording && task.recorded_duration ? recordedText(task.recorded_duration) : "",
    task.last_media_sequence != null ? `媒体序列 #${task.last_media_sequence}` : "",
    task.segments_total ? `切片 ${task.segments_completed || 0}/${task.segments_total}` : "",
    task.retry_count ? `累计重试 ${task.retry_count} 次` : "",
    task.message && !["failed", "partial"].includes(task.state) ? task.message : ""
  ].filter(Boolean);
});
const line = computed(() => props.compact && !isRecording(props.task) && showProgress.value ? `${progressText(props.task)} · ${statusLine(props.task)}` : statusLine(props.task));
</script>

<template>
  <article class="task-row" :class="{ compact, readonly, expanded, active: isActive(task) }">
    <span class="task-icon" :data-state="isRecording(task) ? 'recording' : task.state"><SfIcon :name="stateIcon(task)" :class="{ spin: isWorking(task) && !isRecording(task) }" /></span>
    <component :is="readonly ? 'div' : 'button'" class="task-main" v-bind="readonly ? {} : { type: 'button', 'aria-expanded': Boolean(expanded) }" :title="task.title" @click="!readonly && emit('toggle')">
      <strong>{{ task.title }}</strong>
      <small>{{ line }}</small>
      <span v-if="showProgress" class="progress-track" :class="{ live: isRecording(task) && task.phase === 'recording' }"><i :style="{ width: isRecording(task) && task.phase === 'recording' ? '36%' : progressWidth }"></i></span>
    </component>
    <span v-if="!compact || isRecording(task)" class="task-percent">{{ progressText(task) }}</span>
    <span v-if="!readonly" class="task-actions">
      <button v-if="actions.primary" class="button sm" :class="{ 'icon-only': compact, 'primary-soft': actions.primary.key !== 'stop', 'danger-ghost': actions.primary.key === 'stop' }" type="button" :disabled="offline" :aria-label="`${actions.primary.label}：${task.title}`" :title="actions.primary.label" @click="emit('action', actions.primary.key)"><SfIcon :name="actions.primary.icon" /><span v-if="!compact">{{ actions.primary.label }}</span></button>
      <SfMenu :items="menuItems" :label="`更多操作：${task.title}`" @select="key => emit('action', key as TaskActionKey)" />
    </span>
    <div v-if="expanded && !readonly" class="task-detail">
      <div v-if="metrics.length || task.failed_segments" class="task-metrics"><span v-for="metric in metrics" :key="metric">{{ metric }}</span><span v-if="task.failed_segments" class="metric-danger">失败 {{ task.failed_segments }} 个</span></div>
      <div v-if="task.outputs?.length" class="task-outputs"><div v-for="(output, index) in task.outputs" :key="index"><span class="tag">{{ taskOutputLabel(task, output) }}</span><strong :title="output.path || undefined">{{ output.path || '等待生成文件' }}</strong><em :data-state="output.state">{{ output.state === 'succeeded' ? '已完成' : output.state === 'failed' ? '失败' : '处理中' }}</em><span v-if="output.path && output.state === 'succeeded'" class="task-output-actions"><button class="icon-button" type="button" aria-label="打开文件夹" title="打开文件夹" @click="emit('reveal', output.path)"><SfIcon name="folder" /></button><button class="icon-button" type="button" aria-label="复制文件夹路径" title="复制文件夹路径" @click="emit('copyFolder', output.path)"><SfIcon name="copy" /></button></span></div></div>
      <div v-else-if="task.output" class="task-outputs"><div><span class="tag">输出</span><strong :title="task.output">{{ task.output }}</strong><span v-if="task.state === 'succeeded'" class="task-output-actions"><button class="icon-button" type="button" aria-label="打开文件夹" title="打开文件夹" @click="emit('reveal', task.output)"><SfIcon name="folder" /></button><button class="icon-button" type="button" aria-label="复制文件夹路径" title="复制文件夹路径" @click="emit('copyFolder', task.output)"><SfIcon name="copy" /></button></span></div></div>
      <div v-if="task.resume_requirement" class="resume-notice"><strong>{{ resumeNotice(task) }}</strong><span v-if="task.resume_requirement !== 'dash_reparse_required'">已完成切片和检查点会保留，不会从头下载。</span></div>
    </div>
  </article>
</template>
