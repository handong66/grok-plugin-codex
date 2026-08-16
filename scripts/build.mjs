#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const packageVersion = JSON.parse(await readFile("package.json", "utf8")).version;

const outdir = "plugins/grok-plugin-codex/dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    server: "plugins/grok-plugin-codex/src/server.ts",
    "job-worker": "plugins/grok-plugin-codex/src/job-worker.ts"
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  // GPC-10.2: the published version is a build fact, not a literal a human keeps in sync.
  define: { __GROK_PLUGIN_VERSION__: JSON.stringify(packageVersion) },
  legalComments: "none",
  logLevel: "info"
});

for (const output of ["server.js", "job-worker.js"]) {
  const path = `${outdir}/${output}`;
  const bundled = await readFile(path, "utf8");
  await writeFile(path, bundled.replace(/[ \t]+$/gm, ""));
  await chmod(path, 0o755);
}
