<script setup lang="ts">
import { icons, type IconName } from "./icons";

defineProps<{ name: IconName; size?: number }>();
</script>

<template>
  <svg class="sf-icon" :width="size || 16" :height="size || 16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path v-for="(path, index) in icons[name]" :key="index" :d="path" /></svg>
</template>
