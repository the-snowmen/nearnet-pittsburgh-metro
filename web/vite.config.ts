import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// Relative base so the build works both at the dev root and under the
// GitHub Pages project path (the-snowmen.github.io/nearnet-pittsburgh-metro/).
export default defineConfig({
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  // DuckDB-WASM ships its own workers/wasm; don't let esbuild pre-bundle it.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es" },
  server: { port: 5173, strictPort: false },
});
