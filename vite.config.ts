/**
 * Grok/Vercel detect the app from the repo root. The real Vite+Nitro config
 * lives in apps/web — keep that as the source of truth.
 */
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import web from "./apps/web/vite.config.ts";

const webRoot = fileURLToPath(new URL("./apps/web", import.meta.url));

export default defineConfig(async (env) => {
  const resolved = await Promise.resolve(typeof web === "function" ? web(env) : web);
  return mergeConfig(resolved, { root: webRoot });
});
