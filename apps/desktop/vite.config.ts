import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port; fail instead of silently picking another one.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Never watch cargo's build output — its locked artifacts crash the
    // watcher on Windows (EBUSY) mid-compile.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The repo root, not this directory. Every other part of the stack reads the
  // one .env at the root, and having the desktop be the exception is a trap:
  // setting VITE_API_URL there would look right, change nothing, and the app
  // would quietly keep talking to localhost after a cutover to the server.
  envDir: "../..",
});
