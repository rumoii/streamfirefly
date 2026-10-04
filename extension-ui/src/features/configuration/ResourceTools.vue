<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { UiContext } from "../../types";
import { sendMessage } from "../../api";
import { sessionError } from "../session-client";
import DeepSearchPanel from "./DeepSearchPanel.vue";
import SfIcon from "../../ui/SfIcon.vue";
const props = defineProps<{ context: UiContext | null }>();
const error = ref("");
const busy = ref(false);
let revision = 0;
watch(() => props.context?.sourceContextId, () => { revision++; error.value = ""; busy.value = false; });
onBeforeUnmount(() => { revision++; });
async function openCapture() {
  if (!props.context?.supported || busy.value) return;
  const current = ++revision;
  busy.value = true;
  try {
    const result = await sendMessage({ type: "capture.control.open", payload: { tabId: props.context?.sourceTabId } });
    if (!result?.ok) throw new Error(result?.error || "无法打开捕捉控制页");
    if (current === revision) error.value = "";
  } catch (reason) { if (current === revision) error.value = sessionError(reason); }
  finally { if (current === revision) busy.value = false; }
}
</script>
<template>
  <div v-if="context?.supported" class="resource-tools">
    <DeepSearchPanel :context="context" />
    <button class="icon-button" :disabled="busy" :aria-label="busy ? '正在打开缓存捕捉…' : '缓存捕捉'" title="打开缓存捕捉控制页" @click="openCapture"><SfIcon name="capture" /></button>
    <span v-if="error" class="resource-tool-error" role="alert">{{ error }}</span>
  </div>
</template>
