<script setup lang="ts">
import SfDialog from "../ui/SfDialog.vue";
import SfIcon from "../ui/SfIcon.vue";
import SfSelect from "../ui/SfSelect.vue";
import TaskRow from "./TaskRow.vue";
import { computed, reactive, ref } from "vue";
import type { DownloadTask } from "../types";
import { validateHlsKeyOverride, type HlsKeyOverrideKind } from "../media";
import { isActive, type TaskActionKey } from "../features/downloads/display";

const props = defineProps<{ tasks: DownloadTask[]; sourceTasks: DownloadTask[]; connected?: boolean; compact?: boolean }>();
const emit = defineEmits<{ control: [task: DownloadTask, action: string, context?: any]; delete: [task: DownloadTask, deleteFile: boolean] }>();
const scope = ref<"current" | "all">("current");
const expanded = ref(new Set<string>());
const pendingDelete = ref<DownloadTask | null>(null);
const deleteStage = ref<"choice" | "confirm">("choice");
const deleteFile = ref(false);
const resumeTask = ref<DownloadTask | null>(null);
const resumeKey = reactive<{ kind: HlsKeyOverrideKind; value: string; iv: string }>({ kind: "hex", value: "", iv: "" });
const keyKinds: { value: HlsKeyOverrideKind; label: string }[] = [{ value: "hex", label: "Hex" }, { value: "base64", label: "Base64" }, { value: "url", label: "密钥 URL" }];
const resumeKeyError = computed(() => resumeTask.value ? validateHlsKeyOverride(resumeKey.kind, resumeKey.value, resumeKey.iv) : "");
const visible = computed(() => scope.value === "current" ? props.sourceTasks : props.tasks);
const summary = computed(() => ({ active: visible.value.filter(isActive).length, succeeded: visible.value.filter(task => task.state === "succeeded").length, failed: visible.value.filter(task => task.state === "failed" || task.state === "partial").length }));

function toggle(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next; }
function runAction(task: DownloadTask, key: TaskActionKey) {
  if (key === "delete") openDelete(task);
  else if (key === "resume") requestResume(task);
  else emit("control", task, key);
}
function openDelete(task: DownloadTask) { pendingDelete.value = task; deleteStage.value = "choice"; }
function choose(value: boolean) { deleteFile.value = value; deleteStage.value = "confirm"; }
function confirmDelete() { if (pendingDelete.value) emit("delete", pendingDelete.value, deleteFile.value); pendingDelete.value = null; }
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
  <section class="downloads-page" :class="{ compact }">
    <div class="downloads-toolbar">
      <div class="segmented" role="group" aria-label="任务范围"><button type="button" :class="{ active: scope === 'current' }" :aria-pressed="scope === 'current'" @click="scope = 'current'">当前页面 <b>{{ sourceTasks.length }}</b></button><button type="button" :class="{ active: scope === 'all' }" :aria-pressed="scope === 'all'" @click="scope = 'all'">全部任务 <b>{{ tasks.length }}</b></button></div>
      <span v-if="!compact && visible.length" class="downloads-summary">活动 {{ summary.active }} · 已完成 {{ summary.succeeded }} · 失败 {{ summary.failed }}</span>
    </div>
    <div class="task-list">
      <TaskRow v-for="task in [...visible].reverse()" :key="task.id" :task="task" :connected="connected" :compact="compact" :expanded="expanded.has(task.id)" @toggle="toggle(task.id)" @action="key => runAction(task, key)" />
      <div v-if="!visible.length" class="empty-state"><span><SfIcon name="download" :size="22" /></span><h3>{{ scope === 'current' ? '当前页面还没有下载任务' : '暂无下载任务' }}</h3><p>从资源页选择媒体并开始下载后，任务会显示在这里。</p></div>
    </div>
    <Transition name="fade">
      <SfDialog v-if="pendingDelete" :title="deleteStage === 'choice' ? '删除下载任务' : '再次确认删除'" :description="pendingDelete.title" size="sm" @close="pendingDelete = null">
        <div v-if="deleteStage === 'choice'" class="delete-choices"><button @click="choose(false)"><strong>仅删除任务记录</strong><span>保留已经下载到本地的文件</span></button><button class="danger-choice" @click="choose(true)"><strong>删除记录和本地文件</strong><span>同时删除该任务产生的视频及字幕文件</span></button></div>
        <div v-else class="confirm-warning"><b><SfIcon name="alert-triangle" :size="14" /></b><div><strong>{{ deleteFile ? '确认永久删除任务和全部本地文件？' : '确认只删除任务记录？' }}</strong><p>{{ deleteFile ? '此操作无法撤销。主视频和附属字幕文件都会被删除。' : '本地文件将继续保留。' }}</p></div></div>
        <template v-if="deleteStage === 'confirm'" #footer><button class="button" @click="deleteStage = 'choice'">返回</button><button class="button danger-solid" @click="confirmDelete">确认删除</button></template>
      </SfDialog>
    </Transition>
    <Transition name="fade">
      <SfDialog v-if="resumeTask" title="重新输入 AES-128 密钥" :description="resumeTask.title" @close="resumeTask = null">
        <div class="resume-key-form"><div class="field"><span>密钥格式</span><SfSelect v-model="resumeKey.kind" :options="keyKinds" label="密钥格式" /></div><label><span>{{ resumeKey.kind === 'url' ? '密钥地址' : '密钥内容' }}</span><input v-model="resumeKey.value" class="control" autocomplete="off"></label><label><span>自定义 IV（可选）</span><input v-model="resumeKey.iv" class="control" autocomplete="off" placeholder="32 位十六进制"></label><p v-if="resumeKeyError" class="inline-error">{{ resumeKeyError }}</p><p class="privacy-hint">密钥只用于本次恢复，不会写入任务记录或检查点。</p></div>
        <template #footer><button class="button" @click="resumeTask = null">取消</button><button class="button primary" :disabled="Boolean(resumeKeyError)" @click="confirmResume">验证并继续</button></template>
      </SfDialog>
    </Transition>
  </section>
</template>
