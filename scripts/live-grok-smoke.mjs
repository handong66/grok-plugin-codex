#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

const sentinel = "GROK_PLUGIN_CODEX_OK";

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
  { name: "grok-plugin-codex-live-smoke", version: "0.2.0" },
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
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
