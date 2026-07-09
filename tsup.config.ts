import { defineConfig } from "tsup";

export default defineConfig([
  // CLI binary — needs shebang
  {
    entry: { "bin/crewdeck": "bin/crewdeck.ts" },
    outDir: "dist",
    format: "esm",
    target: "node20",
    platform: "node",
    splitting: false,
    clean: true,
    sourcemap: true,
    external: ["better-sqlite3"],
    banner: { js: "#!/usr/bin/env node" },
  },
  // Server library
  {
    entry: { "server/index": "server/index.ts" },
    outDir: "dist",
    format: "esm",
    target: "node20",
    platform: "node",
    splitting: true,
    clean: false, // Don't clean — bin was already built
    sourcemap: true,
    external: ["better-sqlite3"],
  },
]);
