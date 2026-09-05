import { createApp } from "vue";
import { createPinia } from "pinia";
import WorkspaceApp from "./WorkspaceApp.vue";
import styles from "./styles.css?inline";

const api = (globalThis as any).browser ?? (globalThis as any).chrome;
const hostId = "streamfirefly-workspace-host";
const existing = document.getElementById(hostId);

if (!existing) {
  const host = document.createElement("div");
  host.id = hostId;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483646;display:block;color-scheme:light;--primary:#36a990;--primary-dark:#287a69;--primary-soft:#eaf7f4;--success:#287a69;--warning:#d99119;--danger:#dc5360;--line:#dce5ef;--muted:#71839a;--panel:#fff;--shadow:0 7px 22px rgba(37,58,85,.05)} ${styles}`;
  const root = document.createElement("div");
  root.id = "app";
  shadow.append(style, root);
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
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(api?.runtime?.sendMessage?.({ type: "workspace.close" })).catch(dispose);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("streamfirefly-workspace-unmount", dispose, { once: true });
}
