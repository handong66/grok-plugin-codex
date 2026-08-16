import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkVerificationRecords } from "../scripts/lib/verification-gate.mjs";

/**
 * X8 / GPC-01.6. 0.3.0 is versioned, dated and described as the current release while its own
 * required live gate has never run — and the only thing saying so was a sentence in a document.
 * `GROK_PLUGIN_RELEASE=1 npm run validate:plugin` now refuses a release whose live record is
 * missing, undated, or "not run". The offline gate cannot stand in: it observes no Grok CLI, and
 * the 0.2.1 stop-reason regression this release fixes passed every offline gate for a month.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const verification = readFileSync(new URL("../docs/verification.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function doc(offline: string, live: string): string {
  return `# Verification\n\n${offline}\n\n${live}\n\nEvery release must add both lines.\n`;
}

const OFFLINE_OK = "Offline gate, 0.3.0: verified 2026-08-16 — `npm run check` green on macOS 26.6.1,\nNode v25.9.0.";
const LIVE_OK =
  "Live gate, 0.3.0: verified 2026-08-17 — `npm run smoke:live-grok` passed against Grok CLI 1.0.3\non macOS 26.6.1.";

describe("release gate on the verification record", () => {
  it("accepts a dated live record that names the CLI version", () => {
    expect(checkVerificationRecords(doc(OFFLINE_OK, LIVE_OK), "0.3.0", { release: true })).toEqual([]);
  });

  it("blocks a release whose live gate has not run", () => {
    const notRun = doc(OFFLINE_OK, "Live gate, 0.3.0: **not run**. `npm run smoke:live-grok` has not been executed.");

    const errors = checkVerificationRecords(notRun, "0.3.0", { release: true });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("smoke:live-grok");
    // Development builds must still pass: "not run" is the honest state of an unreleased branch.
    expect(checkVerificationRecords(notRun, "0.3.0", { release: false })).toEqual([]);
  });

  it("blocks a release whose live record names no CLI version", () => {
    const vague = doc(OFFLINE_OK, "Live gate, 0.3.0: verified 2026-08-17 — the live smoke passed locally.");

    expect(checkVerificationRecords(vague, "0.3.0", { release: true })).toEqual([
      expect.stringContaining("Grok CLI <x.y.z>")
    ]);
  });

  it("blocks a release whose live record carries no date", () => {
    const undated = doc(OFFLINE_OK, "Live gate, 0.3.0: verified against Grok CLI 1.0.3.");

    expect(checkVerificationRecords(undated, "0.3.0", { release: true })).toEqual([
      expect.stringContaining("YYYY-MM-DD")
    ]);
  });

  it("requires a record for the version being released, in either mode", () => {
    const stale = doc(OFFLINE_OK, LIVE_OK);

    for (const release of [true, false]) {
      const errors = checkVerificationRecords(stale, "0.3.1", { release });
      expect(errors).toHaveLength(2);
      expect(errors.join("\n")).toContain("Offline gate, 0.3.1:");
      expect(errors.join("\n")).toContain("Live gate, 0.3.1:");
    }
  });

  it("does not accept a mention of the label that is not a record", () => {
    const prose = doc(
      OFFLINE_OK,
      "Append a line shaped like `Live gate, 0.3.0: verified <date> against Grok CLI <x.y.z>` when it runs."
    );

    expect(checkVerificationRecords(prose, "0.3.0", { release: false })).toEqual([
      expect.stringContaining("Live gate, 0.3.0:")
    ]);
  });

  it("rejects an offline record with no date", () => {
    const undated = doc("Offline gate, 0.3.0: `npm run check` green on this machine.", LIVE_OK);

    expect(checkVerificationRecords(undated, "0.3.0", { release: false })).toEqual([
      expect.stringContaining("YYYY-MM-DD")
    ]);
  });

  it("keeps docs/verification.md in step with the version in package.json", () => {
    expect(checkVerificationRecords(verification, packageJson.version, { release: false })).toEqual([]);
  });

  // Wiring: whatever the file says today, validate-plugin must report exactly what the gate reports.
  it("is enforced by validate-plugin under GROK_PLUGIN_RELEASE=1", () => {
    const expected = checkVerificationRecords(verification, packageJson.version, { release: true });
    const run = spawnSync(process.execPath, ["scripts/validate-plugin.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, GROK_PLUGIN_RELEASE: "1" },
      encoding: "utf8"
    });
    const output = `${run.stdout}${run.stderr}`;

    if (expected.length) {
      expect(run.status).not.toBe(0);
      for (const error of expected) expect(output).toContain(error);
    } else {
      expect(output).not.toMatch(/live gate/i);
    }
  });
});
