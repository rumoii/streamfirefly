<script setup lang="ts">
import { computed } from "vue";
import type { DownloadTask } from "../types";
import { formatSpeed } from "../format";

const props = defineProps<{ sourceTasks: DownloadTask[]; activeTasks: DownloadTask[] }>();
const visible = computed(() => {
  const tasks = new Map<string, DownloadTask>();
  for (const task of [...props.sourceTasks, ...props.activeTasks]) tasks.set(task.id, task);
  return [...tasks.values()].slice(-4).reverse();
});

function stateLabel(task: DownloadTask) {
  const labels: Record<string, string> = { queued: "等待下载", starting: "正在连接", running: "正在下载", retrying: "正在恢复", pausing: "正在暂停", paused: "已暂停", cancelling: "正在取消", stopping: "正在停止并保存", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", partial: "部分输出失败", interrupted: "已中断" };
  return labels[task.state] || task.message || task.state;
}
</script>

<template>
  <section class="panel task-overview">
    <div class="panel-title"><div><h2>任务概览</h2><p>当前来源 {{ sourceTasks.length }} 项 · 活动任务 {{ activeTasks.length }} 项</p></div></div>
    <div v-if="visible.length" class="overview-list">
      <article v-for="task in visible" :key="task.id">
        <div><strong>{{ task.title }}</strong><small>{{ stateLabel(task) }}<template v-if="task.speed_bytes_per_second"> · {{ formatSpeed(task.speed_bytes_per_second) }}</template></small></div>
        <span>{{ task.live_recording && activeTasks.some(item => item.id === task.id) ? 'LIVE' : `${task.progress || 0}%` }}</span>
        <i><b :style="{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }"></b></i>
      </article>
    </div>
    <div v-else class="overview-empty">还没有与当前来源相关的任务</div>
  </section>
</template>
