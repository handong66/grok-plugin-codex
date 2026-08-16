#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { arch, release } from "node:os";
import { pathToFileURL } from "node:url";
import { formatLiveGateRecord } from "./lib/verification-gate.mjs";

const sentinel = "GROK_PLUGIN_CODEX_OK";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/grok-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client(
  { name: "grok-plugin-codex-live-smoke", version },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(process.cwd()).href, name: "live-smoke-workspace" }]
}));

try {
  await client.connect(transport);
  const result = await client.callTool(
    {
      name: "grok_run",
      arguments: {
        cwd: process.cwd(),
        prompt: `Reply with exactly: ${sentinel}`,
        ...(process.env.GROK_SMOKE_MODEL ? { model: process.env.GROK_SMOKE_MODEL } : {}),
        disableWebSearch: true,
        noSubagents: true,
        maxTurns: 1,
        background: false,
        timeoutMs: 120000
      }
    },
    undefined,
    { timeout: 130_000 }
  );
  const wrapper = JSON.parse(result.content?.[0]?.text ?? "{}");
  if (result.isError || !wrapper.ok) {
    throw new Error(
      `grok_run failed [${wrapper.error?.code ?? "unknown"}]: ${wrapper.error?.message ?? "No structured error message."}`
    );
  }
  const text = wrapper.data?.finalText ?? "";
  if (String(text).trim() !== sentinel) {
    throw new Error(`Expected exact ${sentinel}, got: ${String(text).trim()}`);
  }
  console.log(`Live Grok smoke passed: ${sentinel}`);
  // A pass that nobody records cannot answer "did this ever work with that CLI", and the release
  // gate in validate-plugin.mjs reads exactly this record.
  //
  // X11: the CLI version comes from the plugin's own discovery — the same `grok --version` call the
  // run above went through — rather than a second lookup that could name a different binary, and the
  // platform comes from this process. The record used to print `<x.y.z>` / `<platform>`, which the
  // gate's `Grok CLI \d+\.\d+\.\d+` rule rejects, so pasting it verbatim still blocked the release.
  const check = await client.callTool(
    { name: "grok_check", arguments: { cwd: process.cwd(), includeModels: false } },
    undefined,
    { timeout: 60_000 }
  );
  const cliVersion = JSON.parse(check.content?.[0]?.text ?? "{}").data?.version;
  console.log(
    `Record it in docs/verification.md, replacing the "Live gate, ${version}:" record:\n` +
      formatLiveGateRecord({
        version,
        cliVersion,
        platform: `${process.platform} ${arch()} ${release()}`,
        nodeVersion: process.version
      })
  );
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
