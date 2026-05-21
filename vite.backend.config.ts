import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: true,
    ssr: true,
    target: "node22",
    rollupOptions: {
      external,
      input: {
        index: resolve(__dirname, "src/index.ts"),
        aiAnalysisWorker: resolve(
          __dirname,
          "src/moderation/aiAnalysisWorker.ts",
        ),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
