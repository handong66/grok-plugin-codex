import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDir(prefix = "grok-plugin-codex-test-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function makeExecutable(path: string, body: string): Promise<string> {
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

/**
 * Grok has shipped two spellings of the same stop reasons. Tests parameterise over both so a
 * future vocabulary change fails loudly instead of silently zeroing out completion detection.
 */
export const STOP_REASON_SPELLINGS = {
  endTurn: ["end_turn", "EndTurn"] as const,
  cancelled: ["cancelled", "Cancelled"] as const
};

export function fakeGrokScript(
  options: { version?: string; modelsOutput?: string; stopReason?: string } = {}
): string {
  const version = options.version ?? "grok fake 1.0.0";
  const stopReason = options.stopReason ?? "end_turn";
  const modelsOutput =
    options.modelsOutput ??
    [
      "You are logged in with grok.com.",
      "",
      "Default model: grok-composer-2.5-fast",
      "",
      "Available models:",
      "  * grok-composer-2.5-fast (default)",
      "  - grok-build"
    ].join("\n");

  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo ${JSON.stringify(version)}
  exit 0
fi
if [ "$1" = "--help" ]; then
  cat <<'HELP_EOF'
--prompt-file <PATH>
--output-format <plain|json|streaming-json>
--permission-mode <default|plan>
--no-subagents
--disable-web-search
--reasoning-effort <EFFORT>
HELP_EOF
  exit 0
fi
if { [ "$1" = "models" ]; } || { [ "$1" = "--cwd" ] && [ "$3" = "models" ]; }; then
  cat <<'MODELS_EOF'
${modelsOutput}
MODELS_EOF
  exit 0
fi
case " $* " in
  *" sessions "*|*" export "*)
    for arg in "$@"; do printf '%s\\n' "$arg"; done
    ;;
  *)
    printf '%s\\n' '{"type":"text","data":"OK"}' '{"type":"end","sessionId":"s1","requestId":"r1","stopReason":"${stopReason}"}'
    ;;
esac
`;
}
