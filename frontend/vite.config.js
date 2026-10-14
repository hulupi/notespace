import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [vue()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ["vue"],
          "element-plus": ["element-plus", "@element-plus/icons-vue"],
          "markdown-editor": ["md-editor-v3", "highlight.js/lib/common"],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT || 3210}`,
        // Preserve the browser-facing Host so the backend can verify Origin.
        changeOrigin: false,
      },
    },
  },
});
