<script setup lang="ts" generic="T extends string">
import { computed, nextTick, ref } from "vue";
import SfIcon from "./SfIcon.vue";
import { usePopover } from "./popover";

const props = defineProps<{ modelValue: T; options: { value: T; label: string }[]; label: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const trigger = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const active = ref(0);
const listId = `sf-select-${Math.random().toString(36).slice(2, 9)}`;
const current = computed(() => props.options.find(option => option.value === props.modelValue));
const { open, style, show, hide } = usePopover(trigger, list, { matchWidth: true, onKey });

async function openList() {
  if (props.disabled) return;
  active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue));
  await show();
  await nextTick();
  list.value?.focus({ preventScroll: true });
}
function choose(index: number) {
  const option = props.options[index];
  if (option) emit("update:modelValue", option.value);
  hide(true);
}
function onTriggerKey(event: KeyboardEvent) {
  if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); void openList(); }
}
function onKey(event: KeyboardEvent) {
  const count = props.options.length;
  if (event.key === "ArrowDown") active.value = (active.value + 1) % count;
  else if (event.key === "ArrowUp") active.value = (active.value - 1 + count) % count;
  else if (event.key === "Home") active.value = 0;
  else if (event.key === "End") active.value = count - 1;
  else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active.value); return; }
  else if (event.key.length === 1) {
    const start = active.value + 1;
    const match = [...props.options.slice(start), ...props.options.slice(0, start)].find(option => option.label.toLowerCase().startsWith(event.key.toLowerCase()));
    if (!match) return;
    active.value = props.options.indexOf(match);
  } else return;
  event.preventDefault();
}
</script>

<template>
  <button ref="trigger" type="button" class="control sf-select" :data-value="modelValue" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? listId : undefined" :disabled="disabled" @click="open ? hide(true) : openList()" @keydown="onTriggerKey">
    <span>{{ current?.label || label }}</span><SfIcon name="chevron-down" :size="14" />
  </button>
  <ul v-if="open" :id="listId" ref="list" class="sf-popover sf-listbox" role="listbox" tabindex="-1" :aria-label="label" :aria-activedescendant="`${listId}-${active}`" :style="style" data-sf-popover>
    <li v-for="(option, index) in options" :id="`${listId}-${index}`" :key="option.value" role="option" :aria-selected="option.value === modelValue" :class="{ active: index === active }" @pointerenter="active = index" @click="choose(index)">
      <span>{{ option.label }}</span><SfIcon v-if="option.value === modelValue" name="check" :size="14" />
    </li>
  </ul>
</template>
