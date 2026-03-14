import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (...paths: string[]) => resolve(__dirname, ...paths);
const tauriDevHost = process.env.TAURI_DEV_HOST?.trim();

function normalizeModuleId(id: string): string {
  return id.replaceAll("\\", "/");
}

function manualChunks(id: string): string | undefined {
  const normalizedId = normalizeModuleId(id);
  if (!normalizedId.includes("/node_modules/")) {
    return undefined;
  }
  if (
    normalizedId.includes("/react/") ||
    normalizedId.includes("/react-dom/") ||
    normalizedId.includes("/scheduler/")
  ) {
    return "vendor-react";
  }
  if (
    normalizedId.includes("/react-router/") ||
    normalizedId.includes("/react-router-dom/")
  ) {
    return "vendor-router";
  }
  if (normalizedId.includes("/@tauri-apps/")) {
    return "vendor-tauri";
  }
  return undefined;
}

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
    host: tauriDevHost || "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 1421,
        }
      : undefined,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: r("dist"),
    emptyOutDir: true,
    // Route-level lazy loading has already reduced the bootstrap chunk substantially.
    // Keep the warning threshold slightly above the remaining shared async UI chunk
    // to avoid noisy warnings in desktop builds.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
