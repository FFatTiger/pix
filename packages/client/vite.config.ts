import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version as string;
// Prefer an explicit release version. Otherwise pin to package+commit so a
// missing version never silently stays "1" across deploys.
const swVersion = process.env.VITE_SW_VERSION ?? `${packageVersion}+${process.env.GITHUB_SHA?.slice(0, 12) ?? "dev"}`;


export default defineConfig({
  define: {
    "import.meta.env.VITE_SW_VERSION": JSON.stringify(swVersion),
    __PIX_SW_VERSION__: JSON.stringify(swVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // Host will own /v1; local Vite dev can forward when a host is running.
      "/v1": {
        target: "http://127.0.0.1:31415",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // React 19 only exports `act` from the development build; keep tests off production entry.
    env: {
      NODE_ENV: "test",
    },
  },
});
