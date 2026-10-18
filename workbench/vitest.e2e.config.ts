import { defineConfig } from "vitest/config";

// The tier that needs a host this repository does not have in CI. TESTPLAN §5 plans `npm run test:e2e`,
// and #123's third box asks for it to be its own tier rather than a few skipped files inside
// `test:integration`: in that suite a skip reads as "the gate ran and this part did not matter",
// which is exactly how a pending live check gets mistaken for a passed one.
//
// What belongs here: anything that reaches a process or a machine outside the workbench - the
// installed REA provider (`REA_LIVE_BIN`), and the real browser lane as soon as it has an automated
// driver. What does NOT: anything that runs against the fixtures and the recorded catalog, which
// stays in `test:integration` so CI keeps covering it.
//
// `tests/unit/test-tiers.test.ts` is the guard that this split cannot rot: every test file has to be
// claimed by exactly one tier, and every tier CI does not run has to say so in the README.
export default defineConfig({
  test: {
    name: "e2e",
    include: ["tests/e2e/**/*.test.ts"],
    pool: "forks",
    // The live provider is a child process answering over stdio; a cold REA session is measured in
    // tens of seconds on this machine, and a timeout here would read as a failed live check.
    testTimeout: 120_000,
  },
});
