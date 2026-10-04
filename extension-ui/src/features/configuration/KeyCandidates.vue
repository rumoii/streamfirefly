<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { UiContext } from "../../types";
import { sessionRequest } from "../session-client";
import SfIcon from "../../ui/SfIcon.vue";
const props = defineProps<{ context: UiContext }>();
const emit = defineEmits<{ select: [hex: string] }>();
const keys = ref<{ hex: string; source: string; frameId: number }[]>([]);
const error = ref("");
let sequence = 0;
onBeforeUnmount(() => { sequence++; });
async function refresh() {
  const current = ++sequence;
  try {
    const response = await sessionRequest("deep.status", { tabId: props.context.sourceTabId });
    if (current === sequence) { keys.value = response.keys; error.value = ""; }
  } catch (reason) { if (current === sequence) error.value = reason instanceof Error ? reason.message : "读取失败"; }
}
watch(() => props.context.sourceContextId, () => { sequence++; keys.value = []; error.value = ""; });
</script>
<template>
  <div class="key-candidate-panel">
    <div class="feature-row"><button class="button sm" @click="refresh"><SfIcon name="radar-2" /><span>读取深度搜索密钥候选</span></button><span v-if="keys.length" class="feature-note">选择仅填入本次下载，仍需通过首片验证。</span></div>
    <div v-for="key in keys" :key="key.hex" class="key-candidate">
      <code>{{ key.hex }}</code><span>{{ key.source }} · frame {{ key.frameId }}</span>
      <button class="button sm" @click="emit('select', key.hex)">使用此候选</button>
    </div>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>
