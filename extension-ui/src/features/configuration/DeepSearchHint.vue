<script setup lang="ts">
import { computed, inject, ref } from "vue";
import SfIcon from "../../ui/SfIcon.vue";
import type { UiContext } from "../../types";
import { deepSearchKey } from "../deep-search/state";
const props = defineProps<{ context: UiContext | null }>();
const deepSearch = inject(deepSearchKey, null);
// Closing lasts only while this view is open and only for the message that was closed.
const dismissed = ref("");
const hint = computed(() => {
  if (!deepSearch || !props.context?.supported) return null;
  const state = deepSearch.state.value, failed = state.frames.filter(frame => frame.state === "failed").length;
  if (!state.enabled) return { kind: "suggest", warning: false, text: "列表里没有想要的视频？试试开启「深度搜索」，能识别网页脚本生成的视频，开启后刷新网页。" };
  if (failed) return { kind: "failed", warning: true, text: `深度搜索有 ${failed} 个框架没能运行，点此查看详情。` };
  if (state.requiresReload) return { kind: "reload", warning: true, text: "深度搜索已开启，刷新网页后才能识别更多视频。" };
  return null;
});
</script>
<template>
  <div v-if="hint && dismissed !== hint.kind" class="capture-hint deep-search-hint" :class="{ warning: hint.warning }" :data-kind="hint.kind">
    <button type="button" class="deep-search-hint-open" @click="deepSearch!.dialogOpen.value = true"><SfIcon :name="hint.warning ? 'alert-triangle' : 'radar-2'" /><span>{{ hint.text }}</span></button>
    <button type="button" class="deep-search-hint-close" aria-label="关闭提示" title="关闭提示" @click="dismissed = hint.kind"><SfIcon name="x" /></button>
  </div>
</template>
