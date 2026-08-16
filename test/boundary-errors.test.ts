import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureWorkspaceRootsProvider,
  grokCheck,
  grokContinue,
  grokReview,
  grokRun
} from "../plugins/grok-plugin-codex/src/tools.js";
import { envelope, fakeGrokScript, makeExecutable, tempDir, withEnv } from "./helpers.js";

function fakeGrok(): string {
  return `#!/bin/sh
	if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
	if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
	previous=""; for arg in "$@"; do if [ "$previous" = "--prompt-file" ]; then cat "$arg" >/dev/null; fi; previous="$arg"; done
	printf '%s\\n' '{"type":"tool_call","toolCallId":"t","name":"read_file","data":{"path":"/tmp/a"}}' '{"type":"text","data":"ok"}' '{"type":"end","stopReason":"end_turn"}'
`;
}

afterEach(() => {
  configureWorkspaceRootsProvider(async () => [process.cwd()]);
});

describe("GK6 private_path_blocked", () => {
  it("names the matched path and offers the Grok-native location", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrok());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          prompt: "read ~/.codex/skills/codex-opencode-collaboration/SKILL.md and summarise it"
        })
      )
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("private_path_blocked");
    expect(parsed.error.details.blockedPath).toContain(".codex");
    // The remedy must name a usable alternative, as the sibling opencode plugin's message already does.
    expect(parsed.error.message).toContain("~/.grok/skills");
    // The prompt itself must not be echoed back.
    expect(JSON.stringify(parsed)).not.toContain("summarise it");
  });
});

describe("GK7 workspace_unavailable", () => {
  it("is retryable and says the roots arrive per turn", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();

    const parsed = envelope(
      await grokRun({ cwd: workspace, background: false, timeoutMs: 30_000, prompt: "hello" })
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("workspace_unavailable");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.message).toMatch(/retry/i);
    expect(parsed.error.details.listRootsCount).toBe(0);
    expect(parsed.error.details.codexMetaRootsCount).toBe(0);
    expect(parsed.error.details.requestedCwd).toBe(workspace);
  });

  it("reuses the last non-empty root set for a turn that carries no metadata", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrok());
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const first = envelope(
      await withEnv(env, () =>
        grokReview({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          target: "src"
        })
      )
    );
    const second = envelope(
      await withEnv(env, () =>
        grokReview({ cwd: workspace, background: false, timeoutMs: 30_000, target: "src" })
      )
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.warnings as string[]).join("\n")).toMatch(/earlier turn/i);
  });
});

/**
 * FINAL Review M7. GK7 lets a turn that carries no roots reuse the root set from an earlier turn,
 * so the call is authorised against the remembered roots — but the state-directory containment check
 * looked only at `cwd`. A private state directory sitting inside one of the *other* active roots
 * therefore passed on exactly those turns, which is when the plugin has the least information.
 */
describe("M7 state containment uses the same roots that authorised the call", () => {
  it("rejects a state directory inside a remembered root that is not the cwd", async () => {
    const workspaceA = await tempDir();
    const workspaceB = await tempDir();
    const cleanState = await tempDir();
    const grokBin = await makeExecutable(join(workspaceA, "grok"), fakeGrok());
    configureWorkspaceRootsProvider(async () => []);

    // Turn 1 carries both roots, so GK7 remembers them.
    const remembered = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: cleanState }, () =>
        grokRun({
          cwd: workspaceA,
          _workspaceRoots: [workspaceA, workspaceB],
          background: false,
          timeoutMs: 30_000,
          prompt: "first"
        })
      )
    );

    // Turn 2 carries no roots at all: the boundary check falls back to the remembered pair, and the
    // state directory now sits inside the root that is not this call's cwd.
    const polluting = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: join(workspaceB, "state") }, () =>
        grokRun({ cwd: workspaceA, background: false, timeoutMs: 30_000, prompt: "second" })
      )
    );

    expect(remembered.ok).toBe(true);
    expect(polluting.ok).toBe(false);
    expect(polluting.error.code).toBe("state_dir_in_workspace");
  }, 40_000);
});

describe("GK8 session_not_found", () => {
  it("falls back to the latest session once when the named one is gone", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const argvLog = join(stateDir, "argv.log");
    const grokBin = await makeExecutable(
      join(workspace, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
	for arg in "$@"; do
	  printf '%s\\n' "$arg" >> ${JSON.stringify(argvLog)}
	  if [ "$prev" = "--prompt-file" ]; then cat "$arg" >/dev/null; fi
	  prev="$arg"
	done
case " $* " in
  *"--resume="*)
    echo "Failed to restore session from remote: 404 Not Found" >&2
    exit 1
    ;;
esac
printf '%s\\n' '{"type":"text","data":"recovered"}' '{"type":"end","stopReason":"end_turn"}'
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          sessionId: "01a00152-52ee-7252-9e7c-9682d567a118",
          fallbackToLatest: true,
          prompt: "finish the review"
        })
      )
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("recovered");
    expect((parsed.warnings as string[]).join("\n")).toContain("fallbackToLatest");
  });
});

describe("GPC-10 diagnostics stay reachable", () => {
  it("runs grok_check without workspace roots when the caller named a cwd", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());

    const parsed = envelope(await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: workspace })));

    expect(parsed.ok).toBe(true);
    expect(parsed.data.cliDiscovered).toBe(true);
    expect((parsed.warnings as string[]).join("\n")).toContain("no workspace roots");
    // GPC-10.2: no literal — the reported version is whatever package.json says.
    const packageVersion = JSON.parse(await readFile("package.json", "utf8")).version;
    expect(parsed.data.pluginVersion).toBe(packageVersion);
  });

  /**
   * X13. Losing the roots must cost the caller the boundary check and nothing else. The fallback
   * used to be `homedir()`, so a `cwd` that does not exist ran the diagnostics — including the
   * opt-in, quota-spending invocation probe — in the user's home directory and reported `ok: true`
   * for a directory the caller never named.
   */
  it("still refuses a cwd that does not exist when the roots are missing", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: join(workspace, "no-such-directory") }))
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("workspace_not_found");
  });

  it("still refuses a cwd that is a file when the roots are missing", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());
    await writeFile(join(workspace, "not-a-directory"), "x");

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: join(workspace, "not-a-directory") }))
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("workspace_invalid");
  });

  it("warns about a leftover 0.1-era job directory in the workspace", async () => {
    const workspace = await tempDir();
    await mkdir(join(workspace, ".grok-plugin-codex"), { recursive: true });
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: workspace, _workspaceRoots: [workspace] }))
    );

    expect((parsed.warnings as string[]).join("\n")).toContain(".grok-plugin-codex/");
    expect((parsed.warnings as string[]).join("\n")).toContain("safe to delete");
  });
});
