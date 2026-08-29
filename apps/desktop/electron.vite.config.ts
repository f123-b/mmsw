import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "repository-import-worker": resolve(__dirname, "src/main/repository-import-worker.ts"),
          "profile-analysis-worker": resolve(__dirname, "src/main/profile-analysis-worker.ts")
        },
        output: { entryFileNames: "[name].js" }
      }
    },
    plugins: [externalizeDepsPlugin({
      exclude: ["@interview-copilot/protocol", "@interview-copilot/shared"]
    })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer")
      }
    },
    plugins: [react()]
  }
});
