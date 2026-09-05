import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  root: "extension-ui",
  base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [vue()],
  build: {
    outDir: "../extension/dist",
    emptyOutDir: false,
    chunkSizeWarningLimit: 900,
    lib: {
      entry: resolve(__dirname, "extension-ui/src/workspace.ts"),
      name: "StreamFireflyWorkspace",
      formats: ["iife"],
      fileName: () => "workspace.js"
    }
  }
});
