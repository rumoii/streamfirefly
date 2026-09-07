<script setup lang="ts">
import { ref } from "vue";
import type { MediaCandidate, UiContext } from "../../types";
import { openDispatch } from "./client";
import DeepSearchPanel from "./DeepSearchPanel.vue";
import CapturePanel from "./CapturePanel.vue";
const props = defineProps<{ candidates: MediaCandidate[]; context: UiContext | null }>();
const candidateId = ref("");
const error = ref("");
async function open() { if (!props.context || !candidateId.value) return; try { await openDispatch(props.context.sourceTabId, props.context.sourceContextId, candidateId.value === "all" ? props.candidates.filter(item => item.type !== "segment").slice(0, 100).map(item => item.id) : [candidateId.value]); error.value = ""; } catch (reason) { error.value = reason instanceof Error ? reason.message : "打开失败"; } }
</script>
<template><CapturePanel :context="context" /><DeepSearchPanel :context="context" /><div v-if="context?.supported && candidates.length" class="feature-panel"><div class="feature-row"><select v-model="candidateId" class="control" aria-label="外部发送资源"><option value="">选择外部发送资源</option><option value="all">当前媒体资源（最多 100 项）</option><option v-for="candidate in candidates.filter(item => item.type !== 'segment')" :key="candidate.id" :value="candidate.id">{{ candidate.pageTitle || candidate.url }}</option></select><button class="button" :disabled="!candidateId" @click="open">发送到…</button></div><p v-if="error" role="alert">{{ error }}</p></div></template>
