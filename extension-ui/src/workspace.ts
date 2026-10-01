import { createApp } from "vue";
import { createPinia } from "pinia";
import WorkspaceApp from "./WorkspaceApp.vue";
import styles from "./styles.css?inline";
import floatingStyles from "./floating.css?inline";

(globalThis as any).__STREAMFIREFLY_SURFACE__ = "workspace";

const hostId = "streamfirefly-workspace-host";
const existing = document.getElementById(hostId);

if (!existing) {
  const host = document.createElement("div");
  host.id = hostId;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none;color-scheme:light;--primary:#36a990;--primary-dark:#287a69;--primary-soft:#eaf7f4;--success:#287a69;--warning:#d99119;--danger:#dc5360;--line:#dce5ef;--muted:#71839a;--panel:#fff;--shadow:0 7px 22px rgba(37,58,85,.05)} ${styles} ${floatingStyles} #app{width:100%;height:100%;min-width:0;min-height:0;pointer-events:none}`;
  const root = document.createElement("div");
  root.id = "app";
  shadow.append(style, root);
  document.documentElement.append(host);

  const app = createApp(WorkspaceApp).use(createPinia());
  app.mount(root);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("streamfirefly-workspace-unmount", dispose);
    app.unmount();
    host.remove();
  };
  window.addEventListener("streamfirefly-workspace-unmount", dispose, { once: true });
}
