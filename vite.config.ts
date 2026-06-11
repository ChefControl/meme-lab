import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Frontend lives in client/; Express (src/server.ts) serves the build output
// from dist/public and owns /api, /proxy and /data — proxy those in dev.
export default defineConfig({
  root: "client",
  plugins: [svelte()],
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5050",
      "/proxy": "http://localhost:5050",
      "/data": "http://localhost:5050",
    },
  },
});
