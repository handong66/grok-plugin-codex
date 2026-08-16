import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // Almost every test in this suite spawns real processes: a fake Grok CLI, a detached worker, and
    // in the lifecycle tests a whole MCP server. Unbounded file parallelism makes those spawns
    // contend for the same cores as the CLI discovery probes they are waiting on, and a probe that
    // loses that race fails on its own 5s budget rather than on the behaviour under test. Four
    // workers keep the suite fast without turning CPU pressure into false failures.
    maxWorkers: 4,
    // The same reasoning applies to the per-test budget. A case that spawns a fake CLI, waits for a
    // detached worker and then reads its ledger costs a second or two of real time on an idle
    // machine; under load the 5s default expires on scheduling, not on the behaviour under test.
    testTimeout: 20_000
  }
});
