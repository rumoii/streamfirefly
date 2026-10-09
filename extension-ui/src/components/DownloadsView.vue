<script setup lang="ts">
import SfDialog from "../ui/SfDialog.vue";
import SfIcon from "../ui/SfIcon.vue";
import SfSelect from "../ui/SfSelect.vue";
import TaskRow from "./TaskRow.vue";
import CaptureRecordList from "../features/capture/CaptureRecordList.vue";
import { computed, reactive, ref } from "vue";
import type { DownloadTask, UiContext } from "../types";
import type { CaptureSnapshot } from "../../../shared/capture";
import { sendMessage } from "../api";
import { folderOf } from "../format";
import { humanError } from "../store";
import { validateHlsKeyOverride, type HlsKeyOverrideKind } from "../media";
import { isActive, type TaskActionKey } from "../features/downloads/display";
import { captureTitle } from "../features/capture/display";
import { useCaptureRecords } from "../features/capture/records";

type SortMode = "newest" | "oldest" | "name" | "size";
const props = defineProps<{ tasks: DownloadTask[]; sourceTasks: DownloadTask[]; connected?: boolean; compact?: boolean; context?: UiContext | null; suspended?: boolean }>();
const emit = defineEmits<{ control: [task: DownloadTask, action: string, context?: any]; delete: [task: DownloadTask, deleteFile: boolean] }>();
const kind = ref<"downloads" | "captures">("downloads");
const scope = ref<"current" | "all">("current");
const query = ref("");
const sort = ref<SortMode>("newest");
const sortOptions: { value: SortMode; label: string }[] = [{ value: "newest", label: "最新优先" }, { value: "oldest", label: "最早优先" }, { value: "name", label: "按名称" }, { value: "size", label: "按大小" }];
const notice = ref("");
const records = useCaptureRecords(computed(() => kind.value === "captures" && !props.suspended));
// One-click capture reloads the page, so recordings belong to the current page by address rather than by page visit.
const pageOf = (url?: string | null) => String(url || "").split("#", 1)[0];
const currentCaptures = computed(() => { const page = pageOf(props.context?.pageUrl); return page ? records.sessions.value.filter(session => pageOf(session.pageUrl) === page) : []; });
const needle = computed(() => query.value.trim().toLowerCase());
const matches = (fields: (string | null | undefined)[]) => !needle.value || fields.some(field => field?.toLowerCase().includes(needle.value));
function ordered<T>(items: T[], time: (item: T) => number, name: (item: T) => string, size: (item: T) => number) {
  const compare: Record<SortMode, (a: T, b: T) => number> = { newest: (a, b) => time(b) - time(a), oldest: (a, b) => time(a) - time(b), name: (a, b) => name(a).localeCompare(name(b), "zh-CN"), size: (a, b) => size(b) - size(a) };
  return [...items].sort(compare[sort.value]);
}
// Tasks carry no creation time; the helper lists them in creation order.
const taskOrder = computed(() => new Map(props.tasks.map((task, index) => [task.id, index])));
const scopedTasks = computed(() => scope.value === "current" ? props.sourceTasks : props.tasks);
const scopedCaptures = computed(() => scope.value === "current" ? currentCaptures.value : records.sessions.value);
const visibleTasks = computed(() => ordered(scopedTasks.value.filter(task => matches([task.title, task.url, task.output, ...(task.outputs || []).map(output => output.path)])), task => taskOrder.value.get(task.id) ?? -1, task => task.title || "", task => task.total_bytes ?? task.downloaded_bytes ?? 0));
const visibleCaptures = computed(() => ordered(scopedCaptures.value.filter((session: CaptureSnapshot) => matches([captureTitle(session), session.pageUrl, ...session.outputs])), session => session.createdAt || 0, captureTitle, session => session.bytes || 0));
const currentCount = computed(() => kind.value === "downloads" ? props.sourceTasks.length : currentCaptures.value.length);
const allCount = computed(() => kind.value === "downloads" ? props.tasks.length : records.sessions.value.length);
async function reveal(task: DownloadTask, path: string) {
  try { const result = await sendMessage({ type: "task.reveal", payload: { id: task.id, path } }); if (!result?.ok) throw new Error(result?.error || "task_reveal_failed"); notice.value = ""; }
  catch (reason) { const code = reason instanceof Error ? reason.message : String(reason); notice.value = code === "unsupported_message" ? "本地助手版本较旧，更新后才能直接打开文件夹；可以先复制文件夹路径。" : humanError(code); }
}
async function copyFolder(path: string) {
  try { await navigator.clipboard.writeText(folderOf(path)); notice.value = "已复制文件夹路径。"; }
  catch { notice.value = "复制失败，请手动选中路径复制。"; }
}
const expanded = ref(new Set<string>());
const pendingDelete = ref<DownloadTask | null>(null);
const deleteStage = ref<"choice" | "confirm">("choice");
const deleteFile = ref(false);
const resumeTask = ref<DownloadTask | null>(null);
const resumeKey = reactive<{ kind: HlsKeyOverrideKind; value: string; iv: string }>({ kind: "hex", value: "", iv: "" });
const keyKinds: { value: HlsKeyOverrideKind; label: string }[] = [{ value: "hex", label: "Hex" }, { value: "base64", label: "Base64" }, { value: "url", label: "密钥 URL" }];
const resumeKeyError = computed(() => resumeTask.value ? validateHlsKeyOverride(resumeKey.kind, resumeKey.value, resumeKey.iv) : "");
const summary = computed(() => ({ active: scopedTasks.value.filter(isActive).length, succeeded: scopedTasks.value.filter(task => task.state === "succeeded").length, failed: scopedTasks.value.filter(task => task.state === "failed" || task.state === "partial").length }));

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
    <div class="segmented downloads-kind" role="group" aria-label="记录类型"><button type="button" :class="{ active: kind === 'downloads' }" :aria-pressed="kind === 'downloads'" @click="kind = 'downloads'">下载 <b>{{ tasks.length }}</b></button><button type="button" :class="{ active: kind === 'captures' }" :aria-pressed="kind === 'captures'" @click="kind = 'captures'">缓存捕捉 <b>{{ records.sessions.value.length }}</b></button></div>
    <div class="downloads-toolbar">
      <div class="segmented" role="group" aria-label="任务范围"><button type="button" :class="{ active: scope === 'current' }" :aria-pressed="scope === 'current'" @click="scope = 'current'">当前页面 <b>{{ currentCount }}</b></button><button type="button" :class="{ active: scope === 'all' }" :aria-pressed="scope === 'all'" @click="scope = 'all'">全部 <b>{{ allCount }}</b></button></div>
      <SfSelect v-model="sort" class="downloads-sort" :options="sortOptions" label="排序" />
      <label class="downloads-search"><SfIcon name="search" /><input v-model="query" class="control" type="search" placeholder="搜索名称、网址或文件路径" aria-label="搜索"></label>
      <span v-if="!compact && kind === 'downloads' && scopedTasks.length" class="downloads-summary">活动 {{ summary.active }} · 已完成 {{ summary.succeeded }} · 失败 {{ summary.failed }}</span>
    </div>
    <p v-if="notice" class="feature-message downloads-notice" role="status">{{ notice }}</p>
    <div v-if="kind === 'downloads'" class="task-list">
      <TaskRow v-for="task in visibleTasks" :key="task.id" :task="task" :connected="connected" :compact="compact" :expanded="expanded.has(task.id)" @toggle="toggle(task.id)" @action="key => runAction(task, key)" @reveal="path => reveal(task, path)" @copy-folder="copyFolder" />
      <div v-if="!visibleTasks.length" class="empty-state"><span><SfIcon :name="needle ? 'search' : 'download'" :size="22" /></span><h3>{{ needle && scopedTasks.length ? '没有符合条件的任务' : scope === 'current' ? '当前页面还没有下载任务' : '暂无下载任务' }}</h3><p>{{ needle && scopedTasks.length ? '换个关键词试试。' : '从资源页选择媒体并开始下载后，任务会显示在这里。' }}</p></div>
    </div>
    <div v-else class="task-list capture-records">
      <p v-if="records.error.value" class="inline-error" role="alert">{{ records.error.value }}</p>
      <CaptureRecordList :sessions="visibleCaptures" :busy="records.busy.value" @recover="records.recover" @remove="records.remove" @remove-failed="records.removeFailed" />
      <div v-if="records.loaded.value && !visibleCaptures.length" class="empty-state"><span><SfIcon :name="needle ? 'search' : 'capture'" :size="22" /></span><h3>{{ needle && scopedCaptures.length ? '没有符合条件的录制' : scope === 'current' ? '当前页面还没有录制记录' : '还没有录制记录' }}</h3><p>{{ needle && scopedCaptures.length ? '换个关键词试试。' : '在资源页点“缓存捕捉”开始录制。' }}</p></div>
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
