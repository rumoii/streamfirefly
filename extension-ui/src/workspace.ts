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
  // Closed so page scripts cannot read or drive the workspace UI; the reference stays in this module.
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none} ${tokens} ${base} ${components} ${styles} ${floatingStyles} #app{width:100%;height:100%;min-width:0;min-height:0;pointer-events:none}`;
  const root = document.createElement("div");
  root.id = "app";
  shadow.append(style, root);
  document.documentElement.append(host);
  // The content script recognizes this host by reference; a page element with the same id must not pass.
  (globalThis as any).__streamFireflyWorkspaceHost = host;
  // A closed shadow is invisible through host.shadowRoot; modal-focus follows this reference instead.
  (globalThis as any).__streamFireflyWorkspaceShadow = shadow;

  const app = createApp(WorkspaceApp).use(createPinia());
  app.mount(root);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("streamfirefly-workspace-unmount", dispose);
    app.unmount();
    if ((globalThis as any).__streamFireflyWorkspaceHost === host) delete (globalThis as any).__streamFireflyWorkspaceHost;
    if ((globalThis as any).__streamFireflyWorkspaceShadow === shadow) delete (globalThis as any).__streamFireflyWorkspaceShadow;
    host.remove();
  };
  window.addEventListener("streamfirefly-workspace-unmount", dispose, { once: true });
}
