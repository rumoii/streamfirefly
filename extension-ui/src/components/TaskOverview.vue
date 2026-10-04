<script setup lang="ts">
import { computed } from "vue";
import type { DownloadTask } from "../types";
import TaskRow from "./TaskRow.vue";

const props = defineProps<{ sourceTasks: DownloadTask[]; activeTasks: DownloadTask[] }>();
const visible = computed(() => {
  const tasks = new Map<string, DownloadTask>();
  for (const task of [...props.sourceTasks, ...props.activeTasks]) tasks.set(task.id, task);
  return [...tasks.values()].slice(-4).reverse();
});
</script>

<template>
  <section class="panel task-overview">
    <div class="panel-title"><div><h2>任务概览</h2><p>当前来源 {{ sourceTasks.length }} 项 · 活动任务 {{ activeTasks.length }} 项</p></div></div>
    <div v-if="visible.length" class="overview-list">
      <TaskRow v-for="task in visible" :key="task.id" :task="task" compact readonly />
    </div>
    <div v-else class="overview-empty">还没有与当前来源相关的任务</div>
  </section>
</template>
