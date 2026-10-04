import { createApp } from "vue";
import { createPinia } from "pinia";
import WorkspaceApp from "./WorkspaceApp.vue";
import tokens from "./theme/tokens.css?inline";
import base from "./theme/base.css?inline";
import components from "./theme/components.css?inline";
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
  style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none} ${tokens} ${base} ${components} ${styles} ${floatingStyles} #app{width:100%;height:100%;min-width:0;min-height:0;pointer-events:none}`;
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
