import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }
          if (id.includes("react-router-dom")) {
            return "vendor-router";
          }
          if (id.includes("react-dom") || id.includes(`${"node_modules"}/react/`) || id.includes("\\react\\")) {
            return "vendor-react";
          }
          if (id.includes("/antd/") || id.includes("\\antd\\") || id.includes("/@ant-design/") || id.includes("\\@ant-design\\")) {
            return "vendor-antd";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3180",
        changeOrigin: true,
      },
    },
  },
});
