import type { ObjectDirective } from "vue";

const cleanup = new WeakMap<HTMLElement, () => void>();
function activeElement(root: Document | ShadowRoot = document): Element | null {
  const active = root.activeElement;
  return active?.shadowRoot ? activeElement(active.shadowRoot) : active;
}

export const vModalFocus: ObjectDirective<HTMLElement, () => void> = {
  mounted(element, binding) {
    const previous = activeElement() as HTMLElement | null;
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(item => !item.hidden && item.getAttribute("aria-hidden") !== "true");
    element.tabIndex = -1;
    queueMicrotask(() => { if (element.isConnected) (focusable()[0] || element).focus(); });
    const onKey = (event: KeyboardEvent) => {
      const root = element.getRootNode() as Document | ShadowRoot;
      const dialogs = root.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== element) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); binding.value(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0] || element;
      const last = items[items.length - 1] || element;
      const active = activeElement();
      if (!element.contains(active) || (event.shiftKey ? active === first || active === element : active === last || active === element)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    cleanup.set(element, () => { window.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); });
  },
  unmounted(element) { cleanup.get(element)?.(); cleanup.delete(element); }
};
