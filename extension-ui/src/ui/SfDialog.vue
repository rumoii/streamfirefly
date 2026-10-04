<script setup lang="ts">
import { vModalFocus } from "../modal-focus";
import SfIcon from "./SfIcon.vue";

defineProps<{ title: string; description?: string; closeLabel?: string; size?: "sm" | "md" | "lg" }>();
const emit = defineEmits<{ close: [] }>();
const titleId = `sf-dialog-${Math.random().toString(36).slice(2, 9)}`;
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section v-modal-focus="() => emit('close')" class="dialog" :class="size || 'md'" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <header class="dialog-heading">
        <div><h2 :id="titleId">{{ title }}</h2><p v-if="description">{{ description }}</p></div>
        <button class="icon-button" type="button" :aria-label="closeLabel || '关闭'" @click="emit('close')"><SfIcon name="x" /></button>
      </header>
      <div class="dialog-body"><slot /></div>
      <footer v-if="$slots.footer" class="dialog-actions"><slot name="footer" /></footer>
    </section>
  </div>
</template>
