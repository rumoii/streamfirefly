<script setup lang="ts">
import { nextTick, ref } from "vue";
import SfIcon from "./SfIcon.vue";
import type { IconName } from "./icons";
import { usePopover } from "./popover";

export type MenuItem = { key: string; label: string; icon?: IconName; danger?: boolean; disabled?: boolean; title?: string };
const props = defineProps<{ items: MenuItem[]; label: string; icon?: IconName; text?: string; buttonClass?: string; placement?: "start" | "end" }>();
const emit = defineEmits<{ select: [key: string] }>();
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const { open, style, show, hide } = usePopover(trigger, menu, { placement: props.placement || "end", onKey });

function entries() { return [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])]; }
async function openMenu(focusLast = false) {
  await show();
  await nextTick();
  const items = entries();
  (focusLast ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
}
function choose(item: MenuItem) {
  if (item.disabled) return;
  hide(true);
  emit("select", item.key);
}
function onTriggerKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); void openMenu(event.key === "ArrowUp"); }
}
function onKey(event: KeyboardEvent) {
  const items = entries();
  if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const root = menu.value?.getRootNode() as Document | ShadowRoot | undefined;
  const index = items.indexOf(root?.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}
</script>

<template>
  <button ref="trigger" type="button" :class="buttonClass || 'icon-button'" :aria-label="label" :title="label" aria-haspopup="menu" :aria-expanded="open" @click="open ? hide(true) : openMenu()" @keydown="onTriggerKey">
    <SfIcon :name="icon || 'dots'" /><span v-if="text">{{ text }}</span>
  </button>
  <div v-if="open" ref="menu" class="sf-popover sf-menu" role="menu" :aria-label="label" :style="style" data-sf-popover>
    <button v-for="item in items" :key="item.key" type="button" role="menuitem" tabindex="-1" :class="{ danger: item.danger }" :disabled="item.disabled" :title="item.title" @click="choose(item)">
      <SfIcon v-if="item.icon" :name="item.icon" /><span>{{ item.label }}</span>
    </button>
  </div>
</template>
