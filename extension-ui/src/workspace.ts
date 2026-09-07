import { createApp } from "vue";
import { createPinia } from "pinia";
import WorkspaceApp from "./WorkspaceApp.vue";
import styles from "./styles.css?inline";

(globalThis as any).__STREAMFIREFLY_SURFACE__ = "workspace";

const api = (globalThis as any).browser ?? (globalThis as any).chrome;
const hostId = "streamfirefly-workspace-host";
const existing = document.getElementById(hostId);

if (!existing) {
  const host = document.createElement("div");
  host.id = hostId;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483646;display:block;width:100vw;height:100vh;overflow:hidden;color-scheme:light;--primary:#36a990;--primary-dark:#287a69;--primary-soft:#eaf7f4;--success:#287a69;--warning:#d99119;--danger:#dc5360;--line:#dce5ef;--muted:#71839a;--panel:#fff;--shadow:0 7px 22px rgba(37,58,85,.05)}#app{width:100%;height:100%;min-height:0;overflow:hidden} ${styles}`;
  const root = document.createElement("div");
  root.id = "app";
  shadow.append(style, root);
  const previousScrollStyle = {
    htmlOverflow: document.documentElement.style.overflow,
    htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
    bodyOverflow: document.body?.style.overflow || "",
    bodyOverscrollBehavior: document.body?.style.overscrollBehavior || ""
  };
  document.documentElement.style.overflow = "hidden";
  document.documentElement.style.overscrollBehavior = "none";
  if (document.body) {
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
  }
  document.documentElement.append(host);

  const app = createApp(WorkspaceApp).use(createPinia());
  app.mount(root);
  Promise.resolve(api?.runtime?.sendMessage?.({ type: "workspace.ready" })).catch(() => {});
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("streamfirefly-workspace-unmount", dispose);
    app.unmount();
    host.remove();
    document.documentElement.style.overflow = previousScrollStyle.htmlOverflow;
    document.documentElement.style.overscrollBehavior = previousScrollStyle.htmlOverscrollBehavior;
    if (document.body) {
      document.body.style.overflow = previousScrollStyle.bodyOverflow;
      document.body.style.overscrollBehavior = previousScrollStyle.bodyOverscrollBehavior;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || shadow.querySelector('[role="dialog"]')) return;
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(api?.runtime?.sendMessage?.({ type: "workspace.close" })).catch(dispose);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("streamfirefly-workspace-unmount", dispose, { once: true });
}
