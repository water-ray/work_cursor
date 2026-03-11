import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (...paths: string[]) => resolve(__dirname, ...paths);

export default defineConfig({
  root: r("src/renderer"),
  plugins: [react()],
  resolve: {
    alias: {
      "@desktop": r("src/renderer/src/desktop"),
      "@renderer": r("src/renderer/src"),
      "@shared": r("src/shared"),
      "@tauri-icons": r("src-tauri/icons"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: r("dist"),
    emptyOutDir: true,
  },
});
