<script setup lang="ts">
import { nextTick, ref } from "vue";
import SfIcon from "./SfIcon.vue";
import type { IconName } from "./icons";
import { usePopover } from "./popover";

const props = defineProps<{ label: string; icon: IconName; text?: string; badge?: number; placement?: "start" | "end" }>();
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const { open, style, show, hide } = usePopover(trigger, panel, { placement: props.placement || "end" });

async function toggle() {
  if (open.value) { hide(true); return; }
  await show();
  await nextTick();
  panel.value?.querySelector<HTMLElement>("input,select,button")?.focus({ preventScroll: true });
}
</script>

<template>
  <button ref="trigger" type="button" class="button" :class="{ active: open || Boolean(badge) }" :aria-label="label" :title="label" :aria-expanded="open" @click="toggle">
    <SfIcon :name="icon" /><span v-if="text">{{ text }}</span><b v-if="badge" class="count-badge">{{ badge }}</b>
  </button>
  <div v-if="open" ref="panel" class="sf-popover sf-popover-panel" role="group" :aria-label="label" :style="style" data-sf-popover><slot /></div>
</template>
