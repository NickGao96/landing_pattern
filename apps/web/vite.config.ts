import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@landing/data": fileURLToPath(new URL("../../packages/data/src/index.ts", import.meta.url)),
      "@landing/engine": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)),
      "@landing/ui-types": fileURLToPath(new URL("../../packages/ui-types/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
