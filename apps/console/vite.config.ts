import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The console is served by the control plane from its own origin.
    assetsDir: "assets",
    sourcemap: true,
  },
  server: {
    port: 5319,
    proxy: {
      "/api": { target: "http://127.0.0.1:4319", changeOrigin: false },
    },
  },
});
