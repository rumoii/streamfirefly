import { nextTick, onBeforeUnmount, ref, type Ref } from "vue";

// Open popovers carry [data-sf-popover]; the floating shell and modal dialogs leave Escape to them while one is open.
export const POPOVER_SELECTOR = "[data-sf-popover]";

export function hasOpenPopover(root: Document | ShadowRoot | Element | null | undefined): boolean {
  return Boolean(root?.querySelector(POPOVER_SELECTOR));
}

type Placement = "start" | "end";
const keyboardOwners = new Set<(event: Event) => boolean>();

export function usePopover(trigger: Ref<HTMLElement | null>, panel: Ref<HTMLElement | null>, options: { placement?: Placement; matchWidth?: boolean; onKey?: (event: KeyboardEvent) => void } = {}) {
  const open = ref(false);
  const style = ref<Record<string, string>>({ position: "fixed", left: "0px", top: "0px", visibility: "hidden" });
  let listening = false;
  let eventRoot: Window | ShadowRoot = window;

  function inside(event: Event) {
    const path = event.composedPath();
    return Boolean((trigger.value && path.includes(trigger.value)) || (panel.value && path.includes(panel.value)));
  }
  const onPointer = (event: PointerEvent) => { if (!inside(event)) hide(false); };
  const onFocus = (event: FocusEvent) => { if (!inside(event)) hide(false); };
  const onScroll = (event: Event) => {
    if (panel.value && event.composedPath().includes(panel.value)) return;
    // Scrolling a workspace ancestor must not remove a menu while its option is being clicked.
    if (eventRoot instanceof ShadowRoot) position(); else hide(false);
  };
  const onResize = () => hide(false);
  const onKey = (event: KeyboardEvent) => {
    if ([...keyboardOwners].reverse().find(owner => owner(event)) !== inside) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(true); return; }
    if (event.key === "Tab") { if (options.onKey) hide(true); return; }
    options.onKey?.(event);
  };

  const onOutside = (event: Event) => {
    // Window sees only the host of a closed root. Internal events are handled at the root.
    if (eventRoot instanceof ShadowRoot && event.composedPath().includes(eventRoot.host)) return;
    hide(false);
  };

  function listen(active: boolean) {
    if (active === listening) return;
    listening = active;
    if (active) {
      keyboardOwners.add(inside);
      const root = trigger.value?.getRootNode();
      eventRoot = root instanceof ShadowRoot ? root : window;
    } else keyboardOwners.delete(inside);
    const method = active ? "addEventListener" : "removeEventListener";
    eventRoot[method]("pointerdown", onPointer as EventListener, true);
    eventRoot[method]("focusin", onFocus as EventListener, true);
    eventRoot[method]("scroll", onScroll, true);
    eventRoot[method]("keydown", onKey as EventListener, true);
    if (eventRoot !== window) {
      for (const name of ["pointerdown", "focusin", "scroll"]) window[method](name, onOutside, true);
    }
    window[method]("resize", onResize);
    if (!active) eventRoot = window;
  }

  function position() {
    const anchor = trigger.value, element = panel.value;
    if (!anchor || !element) return;
    const triggerRect = anchor.getBoundingClientRect();
    const host = anchor.closest(".floating-window")?.getBoundingClientRect();
    const bounds = host || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    style.value = { position: "fixed", left: "0px", top: "0px", visibility: "hidden", ...(options.matchWidth ? { minWidth: `${triggerRect.width}px` } : {}) };
    void nextTick(() => {
      if (!panel.value || !open.value) return;
      // A containing ancestor may offset fixed elements, so measure where (0, 0) actually lands.
      const origin = panel.value.getBoundingClientRect();
      const width = origin.width, height = origin.height;
      let x = options.placement === "end" ? triggerRect.right - width : triggerRect.left;
      x = Math.max(bounds.left + 4, Math.min(x, bounds.right - 4 - width));
      const below = bounds.bottom - triggerRect.bottom - 8, above = triggerRect.top - bounds.top - 8;
      const flip = height > below && above > below;
      const y = flip ? Math.max(bounds.top + 4, triggerRect.top - 4 - height) : triggerRect.bottom + 4;
      style.value = { ...style.value, left: `${x - origin.left}px`, top: `${y - origin.top}px`, maxHeight: `${Math.max(120, flip ? above : below)}px`, visibility: "visible" };
    });
  }

  async function show() {
    if (open.value) return;
    open.value = true;
    listen(true);
    await nextTick();
    position();
  }
  function hide(focusTrigger: boolean) {
    if (!open.value) return;
    open.value = false;
    listen(false);
    if (focusTrigger) trigger.value?.focus({ preventScroll: true });
  }
  function toggle() { if (open.value) hide(true); else void show(); }

  onBeforeUnmount(() => listen(false));
  return { open, style, show, hide, toggle };
}
