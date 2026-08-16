import { readFileSync } from "node:fs";

/**
 * GPC-10.2: `grok_check` reported `pluginVersion: "0.2.1"` from a string literal, which is a fact the
 * build already knows and a human has to remember. `scripts/build.mjs` defines this identifier from
 * package.json; the runtime fallback only runs when the source is imported unbundled (tests).
 */
declare const __GROK_PLUGIN_VERSION__: string | undefined;

function packageVersion(): string {
  try {
    const packageJson = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(packageJson) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export const PLUGIN_VERSION: string =
  typeof __GROK_PLUGIN_VERSION__ === "string" ? __GROK_PLUGIN_VERSION__ : packageVersion();
