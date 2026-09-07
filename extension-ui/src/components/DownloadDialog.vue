<script setup lang="ts">
import { vModalFocus } from "../modal-focus";
import { computed, onBeforeUnmount, reactive, watch } from "vue";
import type { MediaCandidate } from "../types";
import { sendMessage } from "../api";
import { humanError } from "../store";
import { createDownload, prepareCandidate } from "../download-client";

const props = defineProps<{ candidate: MediaCandidate | null; saveDir: string; downloadThreads: number; sourceContextId: string | null; sourceTabId: number | null; capabilities: string[]; connected?: boolean }>();
const emit = defineEmits<{ close: []; created: [message: string] }>();
const form = reactive({ name: "", extension: "mp4", busy: false, preparing: false, ready: false, error: "" });
let prepared: Record<string, unknown> | null = null;
let preparation = 0;
let requestId = "";

watch(() => props.candidate, async candidate => {
  const token = ++preparation;
  requestId = crypto.randomUUID();
  prepared = null;
  Object.assign(form, { name: "", extension: "mp4", ready: false, preparing: Boolean(candidate), error: "" });
  if (!candidate) return;
  try {
    const payload = await prepareCandidate(candidate, props.sourceTabId);
    if (token !== preparation) return;
    const result = await sendMessage({ type: "task.prepare", payload });
    if (token !== preparation) return;
    if (!result?.ok) throw new Error(result?.error || "task_prepare_failed");
    prepared = payload;
    form.name = result.payload.fileName;
    form.extension = result.payload.extension;
    form.ready = true;
  } catch (reason: any) { if (token === preparation) form.error = humanError(reason?.message); }
  finally { if (token === preparation) form.preparing = false; }
}, { immediate: true });
onBeforeUnmount(() => { preparation++; });

const validation = computed(() => {
  const value = form.name.trim().replace(/[. ]+$/g, "");
  if (!value) return "请输入文件名称";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return "文件名不能包含 Windows 非法字符";
  return "";
});

async function create() {
  if (!props.candidate || validation.value || !form.ready || form.busy || !prepared || props.connected === false) return;
  form.busy = true; form.error = "";
  try {
    const task = await createDownload({ ...prepared, downloadThreads: props.downloadThreads, sourceContextId: props.sourceContextId, fileName: form.name.trim(), saveDir: props.saveDir || null }, requestId);
    const result = { task };
    emit("created", `任务已创建：${result.task?.title || form.name}`);
    emit("close");
  } catch (reason: any) { form.error = humanError(reason?.message); }
  finally { form.busy = false; }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="candidate" class="dialog-backdrop" @click.self="$emit('close')">
      <section v-modal-focus="() => emit('close')" class="dialog" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <div class="dialog-heading"><div><h2 id="download-title">开始下载</h2><p>确认文件名称与保存位置</p></div><button class="icon-button" type="button" aria-label="关闭" @click="$emit('close')">×</button></div>
        <label class="field"><span>文件名称</span><div class="filename"><input v-model="form.name" maxlength="100" @keydown.enter="create"><b>.{{ form.extension }}</b></div><small class="error-text">{{ form.preparing ? "正在准备下载…" : form.error || validation }}</small></label>
        <div class="path-summary"><span>保存目录</span><strong>{{ saveDir || '系统默认目录' }}</strong></div>
        <div class="dialog-actions"><button class="button" type="button" @click="$emit('close')">取消</button><button class="button primary" type="button" :disabled="Boolean(validation) || form.busy || !form.ready || connected === false" @click="create">{{ form.busy ? '正在创建…' : '开始下载' }}</button></div>
      </section>
    </div>
  </Transition>
</template>
