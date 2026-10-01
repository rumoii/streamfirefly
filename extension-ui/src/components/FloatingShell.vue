<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { extensionApi } from "../api";
import { clampRect, defaultLayout, initialRect, LAYOUT_KEY, parseLayout, type DisplayMode, type Rect, type WindowMode } from "../floating-layout";
import logoUrl from "../../../extension/icon48.png?inline";

const props = defineProps<{ count: number; paused: boolean; sniffing: boolean; loading: boolean; beforeLeave: () => boolean }>();
const emit = defineEmits<{ change: [mode: DisplayMode]; close: []; refresh: []; toggleSniffing: [] }>();
const shell = ref<HTMLElement | null>(null);
const mode = ref<DisplayMode>("panel");
const previousMode = ref<Exclude<DisplayMode, "collapsed">>("panel");
const layout = ref(defaultLayout());
const viewport = ref({ width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight });
const rect = ref(initialRect("panel", viewport.value.width, viewport.value.height));
let disposed = false;
let interacted = false;
let pointerCleanup: (() => void) | null = null;
let scrollSnapshot: { element: HTMLElement; overflow: string; overscroll: string }[] | null = null;
let writeQueue = Promise.resolve();
const stateText = computed(() => props.paused ? "已暂停" : props.sniffing ? "正在嗅探" : "等待嗅探");
const launcherStyle = computed(() => ({ left: `${layout.value.launcher.edge === "left" ? 12 : Math.max(12, viewport.value.width - 56)}px`, top: `${12 + layout.value.launcher.yRatio * Math.max(0, viewport.value.height - 68)}px` }));
const windowStyle = computed(() => mode.value === "maximized" ? { inset: "0", width: "100%", height: "100%" } : { left: `${rect.value.x}px`, top: `${rect.value.y}px`, width: `${rect.value.width}px`, height: `${rect.value.height}px` });
function saveLayout() {
  const value = JSON.parse(JSON.stringify(layout.value));
  writeQueue = writeQueue.catch(() => {}).then(async () => { await extensionApi()?.storage?.local?.set({ [LAYOUT_KEY]: value }); }).catch(() => {});
}
function unlockScroll() {
  for (const snapshot of scrollSnapshot || []) { snapshot.element.style.overflow = snapshot.overflow; snapshot.element.style.overscrollBehavior = snapshot.overscroll; }
  scrollSnapshot = null;
}
function updateScroll() {
  if (mode.value !== "maximized") { unlockScroll(); return; }
  if (scrollSnapshot) return;
  scrollSnapshot = [document.documentElement, document.body].filter(Boolean).map(element => ({ element, overflow: element.style.overflow, overscroll: element.style.overscrollBehavior }));
  for (const snapshot of scrollSnapshot) { snapshot.element.style.overflow = "hidden"; snapshot.element.style.overscrollBehavior = "none"; }
}
function blocked() { return Boolean(shell.value?.getRootNode() instanceof ShadowRoot ? (shell.value.getRootNode() as ShadowRoot).querySelector('[aria-modal="true"]') : shell.value?.querySelector('[aria-modal="true"]')); }
function setMode(next: DisplayMode) {
  if (next === mode.value) return;
  if (blocked() || (next === "panel" && mode.value !== "collapsed" && !props.beforeLeave())) return;
  interacted = true;
  pointerCleanup?.();
  if (mode.value === "panel" || mode.value === "workspace") layout.value[mode.value] = { ...rect.value };
  if (next === "collapsed") previousMode.value = mode.value as Exclude<DisplayMode, "collapsed">;
  if (next === "panel" || next === "workspace") rect.value = clampRect(layout.value[next] || initialRect(next, viewport.value.width, viewport.value.height), next, viewport.value.width, viewport.value.height);
  mode.value = next;
  updateScroll();
  emit("change", next);
  void nextTick(() => shell.value?.focus({ preventScroll: true }));
}
function restore() { if (mode.value === "collapsed") setMode(previousMode.value); else shell.value?.focus({ preventScroll: true }); }
function maximize() { setMode(mode.value === "maximized" ? "workspace" : "maximized"); }
function close() { if (!blocked() && props.beforeLeave()) emit("close"); }
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || blocked() || !event.composedPath().some(node => node === shell.value)) return;
  event.preventDefault(); event.stopPropagation();
  setMode(mode.value === "maximized" ? "workspace" : mode.value === "workspace" ? "panel" : "collapsed");
}
function onResize() {
  pointerCleanup?.();
  viewport.value = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
  if (mode.value === "panel" || mode.value === "workspace") rect.value = clampRect(layout.value[mode.value] || initialRect(mode.value, viewport.value.width, viewport.value.height), mode.value, viewport.value.width, viewport.value.height);
}
function beginPointer(event: PointerEvent, edge = "", launcher = false) {
  if (event.button !== 0 || blocked() || !launcher && mode.value === "maximized") return;
  if (!edge && !launcher && (event.target as HTMLElement).closest("button,input,select,a")) return;
  interacted = true;
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  const initial = { ...rect.value };
  const originalLauncher = { ...layout.value.launcher };
  const startX = event.clientX, startY = event.clientY;
  let moved = false;
  target.setPointerCapture?.(event.pointerId);
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    const dx = next.clientX - startX, dy = next.clientY - startY;
    moved ||= Math.abs(dx) + Math.abs(dy) > 4;
    if (launcher) {
      if (moved) layout.value.launcher = { edge: next.clientX < viewport.value.width / 2 ? "left" : "right", yRatio: Math.min(1, Math.max(0, (next.clientY - 34) / Math.max(1, viewport.value.height - 68))) };
      return;
    }
    const nextRect = { ...initial };
    if (!edge) { nextRect.x += dx; nextRect.y += dy; }
    else {
      const minWidth = Math.min(mode.value === "panel" ? 360 : 760, viewport.value.width - 24);
      const minHeight = Math.min(mode.value === "panel" ? 300 : 420, viewport.value.height - 24);
      if (edge.includes("e")) nextRect.width = Math.max(minWidth, initial.width + dx);
      if (edge.includes("s")) nextRect.height = Math.max(minHeight, initial.height + dy);
      if (edge.includes("w")) { nextRect.width = Math.max(minWidth, initial.width - dx); nextRect.x = initial.x + initial.width - nextRect.width; }
      if (edge.includes("n")) { nextRect.height = Math.max(minHeight, initial.height - dy); nextRect.y = initial.y + initial.height - nextRect.height; }
    }
    rect.value = clampRect(nextRect, mode.value as WindowMode, viewport.value.width, viewport.value.height);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel);
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    pointerCleanup = null;
  };
  const finish = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    cleanup();
    if (!launcher && (mode.value === "panel" || mode.value === "workspace")) layout.value[mode.value] = { ...rect.value };
    if (moved) saveLayout();
    if (launcher && !moved) restore();
  };
  const cancel = (next: PointerEvent) => { if (next.pointerId !== event.pointerId) return; rect.value = initial; layout.value.launcher = originalLauncher; cleanup(); };
  pointerCleanup?.(); pointerCleanup = cleanup;
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", cancel);
}
onMounted(async () => {
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKey, true);
  try { const stored = await extensionApi()?.storage?.local?.get(LAYOUT_KEY); if (!disposed && !interacted) { layout.value = parseLayout(stored?.[LAYOUT_KEY]); rect.value = clampRect(layout.value.panel || initialRect("panel", viewport.value.width, viewport.value.height), "panel", viewport.value.width, viewport.value.height); } } catch (_) {}
});
onBeforeUnmount(() => { disposed = true; pointerCleanup?.(); unlockScroll(); window.removeEventListener("resize", onResize); window.visualViewport?.removeEventListener("resize", onResize); window.removeEventListener("keydown", onKey, true); });
defineExpose({ setMode, restore, mode });
</script>

<template>
  <button v-if="mode === 'collapsed'" class="floating-launcher" :style="launcherStyle" :title="`流萤 · ${count} 个资源 · ${stateText}`" aria-label="恢复流萤面板" @pointerdown="beginPointer($event, '', true)" @click="($event.detail === 0) && restore()"><img :src="logoUrl" alt="流萤"><b>{{ count > 99 ? '99+' : count }}</b><i :class="{ paused: paused || !sniffing }"></i></button>
  <section v-show="mode !== 'collapsed'" ref="shell" class="floating-window" :class="[mode, { 'is-collapsed': mode === 'collapsed' }]" :style="windowStyle" tabindex="-1" aria-label="流萤" :data-display-mode="mode">
    <header class="floating-titlebar" @pointerdown="beginPointer($event)">
      <img class="brand-logo" :src="logoUrl" alt="流萤"><h1>流萤</h1><span class="floating-state"><i :class="{ paused: paused || !sniffing }"></i>{{ stateText }}</span>
      <div class="floating-controls">
        <button class="icon-button" :aria-label="paused ? '继续嗅探' : '暂停嗅探'" :title="paused ? '继续嗅探' : '暂停嗅探'" :aria-pressed="paused" @click="emit('toggleSniffing')"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="paused" d="m8 5 11 7-11 7Z"/><path v-else d="M8 5v14M16 5v14"/></svg></button>
        <button class="icon-button" aria-label="刷新" title="刷新" :disabled="loading" @click="emit('refresh')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5"/></svg></button>
        <button v-if="mode !== 'panel'" class="icon-button" :aria-label="mode === 'maximized' ? '还原工作区' : '最大化工作区'" :title="mode === 'maximized' ? '还原工作区' : '最大化工作区'" @click="maximize"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="mode === 'maximized'" d="M8 8h12v12H8ZM4 16V4h12"/><path v-else d="M4 4h16v16H4Z"/></svg></button>
        <button class="icon-button" aria-label="收起流萤" title="收起流萤" @click="setMode('collapsed')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h14"/></svg></button>
        <button class="icon-button" aria-label="关闭流萤" title="关闭流萤" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </div>
    </header>
    <slot :mode="mode" />
    <template v-if="mode !== 'maximized'"><span v-for="edge in ['n','e','s','w','ne','se','sw','nw']" :key="edge" class="resize-handle" :class="edge" aria-hidden="true" @pointerdown="beginPointer($event, edge)"></span></template>
  </section>
</template>
