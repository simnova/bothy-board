/**
 * Grok/Vercel deploys from <repo>/.vercel/output. Turbo+Nitro emit that
 * tree under apps/web/.vercel/output. Copy it to the repo root so publish
 * does not ship the leftover pre-monorepo bundle.
 *
 * Also copies PGLite wasm/data next to the bundled driver — Nitro/Rolldown
 * inlines the JS but drops those files, and the function then 500s on boot.
 */
import { copyFileSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/web/.vercel/output");
const dest = join(root, ".vercel/output");

if (!existsSync(src)) {
  console.error(`[sync-vercel-output] missing ${src} — run the web build first`);
  process.exit(1);
}

function pgliteDist() {
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("@electric-sql/pglite/package.json")), "dist");
  } catch {
    return join(
      root,
      "node_modules/.pnpm/@electric-sql+pglite@0.5.7/node_modules/@electric-sql/pglite/dist",
    );
  }
}

function copyPgliteAssets(outputDir) {
  const dist = pgliteDist();
  const files = ["initdb.wasm", "pglite.data"];
  const functions = join(outputDir, "functions");
  if (!existsSync(functions) || !existsSync(dist)) return 0;
  let n = 0;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "_libs") {
          for (const file of files) {
            const from = join(dist, file);
            if (!existsSync(from)) continue;
            copyFileSync(from, join(path, file));
            n += 1;
          }
        } else {
          walk(path);
        }
      }
    }
  };
  walk(functions);
  return n;
}

const copied = copyPgliteAssets(src);
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(
  `[sync-vercel-output] copied apps/web/.vercel/output → .vercel/output (pglite assets ${copied})`,
);
