import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

async function createClient(env: NodeJS.ProcessEnv, workspace: string): Promise<Client> {
  const transportEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["plugins/grok-plugin-codex/dist/server.js"],
    cwd: process.cwd(),
    env: transportEnv,
    stderr: "pipe"
  });
  const client = new Client(
    { name: "background-lifecycle-test", version: "0.2.0" },
    { capabilities: { roots: {} } }
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspace).href, name: "background-test-workspace" }]
  }));
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 })) as any;
  const text = result.content?.find((item: any) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text.`);
  const parsed = JSON.parse(text) as Record<string, any>;
  if (result.isError || !parsed.ok) throw new Error(`${name} failed: ${text}`);
  expect(parsed).toEqual(result.structuredContent);
  return parsed.data as Record<string, any>;
}

async function waitFor<T>(operation: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T;
  do {
    latest = await operation();
    if (predicate(latest)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  } while (Date.now() < deadline);
  throw new Error("Condition was not met before timeout.");
}

async function makeFakeGrok(path: string, body: string): Promise<string> {
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("background lifecycle across MCP restarts", () => {
  test("a second MCP process can read and cancel a job while killing its process tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "grandchild-completed.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "slow-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { readFile, writeFile } from 'node:fs/promises';",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        "const promptIndex = args.indexOf('--prompt-file');",
        "const prompt = await readFile(args[promptIndex + 1], 'utf8');",
        "if (!prompt.includes('cross-process cancellation probe')) process.exit(9);",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 700)`) }], { stdio: 'ignore' });`,
        "console.log(JSON.stringify({ type: 'text', data: 'working before restart' }));",
        "setTimeout(() => { console.log(JSON.stringify({ type: 'text', data: 'late result' })); console.log(JSON.stringify({ type: 'end', sessionId: 's1' })); }, 5000);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const first = await createClient(env, workspace);
    const started = await call(first, "grok_run", {
      cwd: workspace,
      prompt: "cross-process cancellation probe",
      background: true,
      timeoutMs: 10_000
    });
    const jobId = started.job.id as string;
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await createClient(env, workspace);
    await waitFor(
      () => call(second, "grok_result", { jobId }),
      (data) => data.stdoutTail.includes("working before restart")
    );
    const cancelled = await call(second, "grok_cancel", { jobId });
    expect(cancelled.job.status).toBe("cancelled");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));

    const result = await call(second, "grok_result", { jobId });
    expect(result.resultComplete).toBe(false);
    expect(result.outputSummary.state).toBe("cancelled_partial");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(workspace, ".grok-plugin-codex"))).toBe(false);

    const recordPath = join(stateDir, "jobs", `${jobId}.json`);
    const recordText = await readFile(recordPath, "utf8");
    expect(recordText).not.toContain("cross-process cancellation probe");
    expect(recordText).not.toContain("--prompt-file");
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(stateDir, "jobs", `${jobId}.input`))).toBe(false);
  }, 15_000);

  test("a detached worker finishes after its originating MCP process closes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "natural-exit-grandchild.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "fast-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 700)`) }], { stdio: 'ignore' }).unref();`,
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ type: 'text', data: 'complete after restart' }));",
        "  console.log(JSON.stringify({ type: 'end', sessionId: 's2', stopReason: 'EndTurn' }));",
        "}, 100);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const first = await createClient(env, workspace);
    const started = await call(first, "grok_run", {
      cwd: workspace,
      prompt: "finish after restart",
      background: true,
      timeoutMs: 5_000
    });
    const jobId = started.job.id as string;
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await createClient(env, workspace);
    const result = await waitFor(
      () => call(second, "grok_result", { jobId }),
      (data) => data.resultComplete === true
    );

    expect(result.finalText).toBe("complete after restart");
    expect(result.outputTruncated).toBe(false);
    expect(result.job.status).toBe("succeeded");
    expect(existsSync(join(stateDir, "jobs", `${jobId}.input`))).toBe(false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  test("background timeout records a typed failure and kills descendants", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "timeout-grandchild.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "timeout-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 700)`) }], { stdio: 'ignore' });`,
        "console.log(JSON.stringify({ type: 'text', data: 'partial before timeout' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'end', sessionId: 'late' })), 5000);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const client = await createClient(env, workspace);
    const started = await call(client, "grok_run", {
      cwd: workspace,
      prompt: "timeout process tree probe",
      background: true,
      timeoutMs: 100
    });
    const jobId = started.job.id as string;

    const result = await waitFor(
      () => call(client, "grok_result", { jobId }),
      (data) => data.job.status === "failed"
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));

    expect(result.job.error.code).toBe("timeout");
    expect(result.resultComplete).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(stateDir, "jobs", `${jobId}.input`))).toBe(false);
  }, 15_000);

  test("a stale worker is reconciled by terminating its verified Grok process group", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "orphan-grandchild.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "orphan-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 8000)`) }], { stdio: 'ignore' });`,
        "console.log(JSON.stringify({ type: 'text', data: 'orphan probe running' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'end', sessionId: 'late-orphan' })), 12000);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const client = await createClient(env, workspace);
    const started = await call(client, "grok_run", {
      cwd: workspace,
      prompt: "worker crash orphan cleanup probe",
      background: true,
      timeoutMs: 20_000
    });
    const jobId = started.job.id as string;
    const recordPath = join(stateDir, "jobs", `${jobId}.json`);
    const running = await waitFor(
      async () => JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>,
      (record) => record.status === "running" && typeof record.pid === "number" && typeof record.workerPid === "number"
    );
    expect(existsSync(join(stateDir, "jobs", `${jobId}.input`))).toBe(false);

    process.kill(running.workerPid, "SIGKILL");
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_300));
      const result = await call(client, "grok_result", { jobId });
      expect(result.job.status).toBe("failed");
      expect(result.job.error.code).toBe("worker_unavailable");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(stateDir, "jobs", `${jobId}.input`))).toBe(false);
    } finally {
      try {
        process.kill(-running.pid, "SIGKILL");
      } catch {
        // The expected path already terminated the verified process group.
      }
    }
  }, 20_000);

  test("a foreground prompt remains worker-owned and is removed after the MCP process closes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "foreground-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ type: 'text', data: 'foreground worker completed' }));",
        "  console.log(JSON.stringify({ type: 'end', sessionId: 'foreground-session' }));",
        "}, 300);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const client = await createClient(env, workspace);
    const pending = client
      .callTool(
        {
          name: "grok_run",
          arguments: { cwd: workspace, prompt: "foreground crash cleanup probe", timeoutMs: 5_000 }
        },
        undefined,
        { timeout: 10_000 }
      )
      .catch(() => undefined);

    await waitFor(
      async () =>
        (await readdir(join(stateDir, "jobs")).catch(() => [])).filter((entry) => entry.endsWith(".input")),
      (inputs) => inputs.length === 1
    );
    await client.close();
    clients.splice(clients.indexOf(client), 1);

    await waitFor(
      async () =>
        (await readdir(join(stateDir, "jobs")).catch(() => [])).filter((entry) => entry.endsWith(".input")),
      (inputs) => inputs.length === 0
    );
    await pending;
  }, 15_000);

  test("cancel reaps the verified launcher tree even after the worker is gone", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "cancel-after-worker-loss.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "cancel-after-worker-loss-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 700)`) }], { stdio: 'ignore' });`,
        "console.log(JSON.stringify({ type: 'text', data: 'ready for lost-worker cancel' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'end', sessionId: 'late-cancel' })), 5000);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const client = await createClient(env, workspace);
    const started = await call(client, "grok_run", {
      cwd: workspace,
      prompt: "cancel after worker loss",
      background: true,
      timeoutMs: 10_000
    });
    const jobId = started.job.id as string;
    const recordPath = join(stateDir, "jobs", `${jobId}.json`);
    const running = await waitFor(
      async () => JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>,
      (record) => record.status === "running" && typeof record.pid === "number" && typeof record.workerPid === "number"
    );
    await waitFor(
      () => call(client, "grok_result", { jobId }),
      (data) => data.stdoutTail.includes("ready for lost-worker cancel")
    );

    process.kill(running.workerPid, "SIGKILL");
    try {
      const cancelled = await call(client, "grok_cancel", { jobId });
      expect(cancelled.job.status).toBe("cancelled");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));
      expect(existsSync(marker)).toBe(false);
    } finally {
      try {
        process.kill(-running.pid, "SIGKILL");
      } catch {
        // Expected cancellation already removed the group.
      }
    }
  }, 15_000);

  test("the worker reaps launcher descendants after the launcher is killed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-plugin-workspace-"));
    const stateDir = await mkdtemp(join(tmpdir(), "grok-plugin-state-"));
    const runtimeDir = await mkdtemp(join(tmpdir(), "grok-plugin-runtime-"));
    tempDirs.push(workspace, stateDir, runtimeDir);
    const marker = join(runtimeDir, "launcher-loss-grandchild.txt");
    const grokBin = await makeFakeGrok(
      join(runtimeDir, "launcher-loss-grok.mjs"),
      [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok 0.2.93'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'), 700)`) }], { stdio: 'ignore' });`,
        "console.log(JSON.stringify({ type: 'text', data: 'ready for launcher loss' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'end', sessionId: 'late-launcher' })), 5000);"
      ].join("\n")
    );
    const env = { ...process.env, GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const client = await createClient(env, workspace);
    const started = await call(client, "grok_run", {
      cwd: workspace,
      prompt: "launcher loss cleanup",
      background: true,
      timeoutMs: 10_000
    });
    const jobId = started.job.id as string;
    const recordPath = join(stateDir, "jobs", `${jobId}.json`);
    const running = await waitFor(
      async () => JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>,
      (record) => record.status === "running" && typeof record.pid === "number"
    );
    await waitFor(
      () => call(client, "grok_result", { jobId }),
      (data) => data.stdoutTail.includes("ready for launcher loss")
    );

    process.kill(running.pid, "SIGKILL");
    const result = await waitFor(
      () => call(client, "grok_result", { jobId }),
      (data) => data.job.status === "failed"
    );
    expect(result.job.error.code).toBe("terminated");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 900));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});
