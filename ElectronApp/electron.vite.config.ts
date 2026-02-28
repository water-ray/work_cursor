import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const r = (...paths: string[]) => resolve(__dirname, ...paths);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": r("src/main"),
        "@shared": r("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@preload": r("src/preload"),
        "@shared": r("src/shared"),
      },
    },
  },
  renderer: {
    root: r("src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": r("src/renderer/src"),
        "@shared": r("src/shared"),
      },
    },
  },
});
