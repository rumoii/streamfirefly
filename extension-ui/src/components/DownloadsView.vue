<script setup lang="ts">
import { computed, ref } from "vue";
import type { DownloadTask } from "../types";
import { formatBytes, formatSpeed } from "../format";

const props = defineProps<{ tasks: DownloadTask[]; sourceTasks: DownloadTask[] }>();
const emit = defineEmits<{ control: [task: DownloadTask, action: string]; delete: [task: DownloadTask, deleteFile: boolean] }>();
const scope = ref<"current" | "all">("current");
const expanded = ref(new Set<string>());
const pendingDelete = ref<DownloadTask | null>(null);
const deleteStage = ref<"choice" | "confirm">("choice");
const deleteFile = ref(false);
const activeStates = new Set(["queued", "starting", "running", "retrying", "pausing", "cancelling"]);
const visible = computed(() => scope.value === "current" ? props.sourceTasks : props.tasks);

function isActive(task: DownloadTask) { return activeStates.has(task.state); }
function stateLabel(task: DownloadTask) {
  const labels: Record<string, string> = { queued: "等待下载", starting: "正在连接", running: task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "下载并合并" : "正在下载", retrying: "正在重试", pausing: "正在暂停", paused: "已暂停", cancelling: "正在取消", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", partial: "部分输出失败", interrupted: "已中断" };
  return labels[task.state] || task.message || task.state;
}
function toggle(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next; }
function openDelete(task: DownloadTask) { pendingDelete.value = task; deleteStage.value = "choice"; }
function choose(value: boolean) { deleteFile.value = value; deleteStage.value = "confirm"; }
function confirmDelete() { if (pendingDelete.value) emit("delete", pendingDelete.value, deleteFile.value); pendingDelete.value = null; }
</script>

<template>
  <section class="downloads-page panel">
    <div class="panel-title downloads-title"><div><h2>下载任务</h2><p>查看当前页面或所有来源创建的任务</p></div><div class="segmented"><button :class="{ active: scope === 'current' }" @click="scope = 'current'">当前页面 <b>{{ sourceTasks.length }}</b></button><button :class="{ active: scope === 'all' }" @click="scope = 'all'">全部任务 <b>{{ tasks.length }}</b></button></div></div>
    <div class="task-list">
      <article v-for="task in [...visible].reverse()" :key="task.id" class="task-card" :class="{ active: isActive(task), expanded: expanded.has(task.id) || isActive(task) }">
        <button class="task-summary" type="button" @click="toggle(task.id)"><span class="task-state-icon" :data-state="task.state">{{ task.state === 'succeeded' ? '✓' : task.state === 'failed' || task.state === 'partial' ? '!' : task.state === 'paused' ? 'Ⅱ' : '↓' }}</span><span class="task-main"><strong>{{ task.title }}</strong><small>{{ stateLabel(task) }}<template v-if="task.output"> · {{ task.output }}</template></small></span><span class="task-percent">{{ task.progress || 0 }}%</span><span class="row-arrow">⌄</span></button>
        <div v-if="expanded.has(task.id) || isActive(task)" class="task-detail">
          <div class="progress-track"><i :style="{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }"></i></div>
          <div class="task-metrics"><span>{{ formatBytes(task.downloaded_bytes) }}<template v-if="task.total_bytes"> / {{ formatBytes(task.total_bytes) }}</template></span><span>{{ formatSpeed(task.speed_bytes_per_second) }}</span><span v-if="task.eta_seconds != null">剩余约 {{ task.eta_seconds }} 秒</span><span>{{ task.message || stateLabel(task) }}</span></div>
          <div v-if="task.outputs?.length" class="task-outputs"><div v-for="(output, index) in task.outputs" :key="index"><span class="tag">{{ output.kind === 'media' ? '视频' : output.language || '字幕' }}</span><strong>{{ output.path || '等待生成文件' }}</strong><em :data-state="output.state">{{ output.state === 'succeeded' ? '已完成' : output.state === 'failed' ? '失败' : '处理中' }}</em></div></div>
          <div class="task-actions"><button v-if="isActive(task) && task.state !== 'pausing'" class="button" @click="$emit('control', task, 'pause')">暂停</button><button v-if="task.state === 'paused'" class="button primary" @click="$emit('control', task, 'resume')">继续</button><button v-if="['failed','cancelled','interrupted','partial'].includes(task.state)" class="button" @click="$emit('control', task, 'retry')">重试</button><button v-if="isActive(task) || task.state === 'paused'" class="button" @click="$emit('control', task, 'cancel')">取消</button><button class="button danger-outline" @click="openDelete(task)">删除</button></div>
        </div>
      </article>
      <div v-if="!visible.length" class="empty-state"><span>↓</span><h3>{{ scope === 'current' ? '当前页面还没有下载任务' : '暂无下载任务' }}</h3><p>从资源页选择媒体并开始下载后，任务会显示在这里。</p></div>
    </div>
    <Transition name="fade"><div v-if="pendingDelete" class="dialog-backdrop" @click.self="pendingDelete = null"><section class="dialog" role="dialog" aria-modal="true"><div class="dialog-heading"><div><h2>{{ deleteStage === 'choice' ? '删除下载任务' : '再次确认删除' }}</h2><p>{{ pendingDelete.title }}</p></div><button class="icon-button" @click="pendingDelete = null">×</button></div><template v-if="deleteStage === 'choice'"><div class="delete-choices"><button @click="choose(false)"><strong>仅删除任务记录</strong><span>保留已经下载到本地的文件</span></button><button class="danger-choice" @click="choose(true)"><strong>删除记录和本地文件</strong><span>同时删除该任务产生的视频及字幕文件</span></button></div></template><template v-else><div class="confirm-warning"><b>!</b><div><strong>{{ deleteFile ? '确认永久删除任务和全部本地文件？' : '确认只删除任务记录？' }}</strong><p>{{ deleteFile ? '此操作无法撤销。主视频和附属字幕文件都会被删除。' : '本地文件将继续保留。' }}</p></div></div><div class="dialog-actions"><button class="button" @click="deleteStage = 'choice'">返回</button><button class="button danger-solid" @click="confirmDelete">确认删除</button></div></template></section></div></Transition>
  </section>
</template>
