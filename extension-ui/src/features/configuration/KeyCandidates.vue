<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { UiContext } from "../../types";
import { configurationRequest } from "./client";
const props = defineProps<{ context: UiContext }>();
const emit = defineEmits<{ select: [hex: string] }>();
const keys = ref<{ hex: string; source: string; frameId: number }[]>([]);
const error = ref("");
let sequence = 0;
onBeforeUnmount(() => { sequence++; });
async function refresh() {
  const current = ++sequence;
  try {
    const response = await configurationRequest<{ keys: typeof keys.value }>("deep.status", { tabId: props.context.sourceTabId });
    if (current === sequence) { keys.value = response.keys; error.value = ""; }
  } catch (reason) { if (current === sequence) error.value = reason instanceof Error ? reason.message : "读取失败"; }
}
watch(() => props.context.sourceContextId, () => { sequence++; keys.value = []; error.value = ""; });
</script>
<template>
  <div class="feature-panel">
    <button class="button small" @click="refresh">读取深度搜索密钥候选</button>
    <p v-if="keys.length">选择仅填入本次下载，仍需通过首片验证。</p>
    <div v-for="key in keys" :key="key.hex" class="feature-row">
      <code>{{ key.hex }}</code><span>{{ key.source }} · frame {{ key.frameId }}</span>
      <button class="button small" @click="emit('select', key.hex)">使用此候选</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
