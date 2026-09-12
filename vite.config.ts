import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  root: "extension-ui",
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "../extension/dist",
    emptyOutDir: true,
    modulePreload: false,
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      input: resolve(__dirname, "extension-ui/app.html"),
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: asset => asset.names?.some(name => name.endsWith(".css")) ? "assets/app.css" : "assets/[name][extname]",
        manualChunks: id => id.includes("node_modules/hls.js") ? "hls" : undefined
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"]
  }
});
