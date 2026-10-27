import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": process.env.CONSOLE_API ?? "http://127.0.0.1:9600" } },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], include: ["src/**/*.test.tsx"], css: false },
} as never);
