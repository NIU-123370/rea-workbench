import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "../../packages/domain/json-value.ts";
import { BOOT_CONFIG_FIELDS } from "../../packages/contracts/boot.ts";
import { bootWorker } from "./composition.ts";
import { startWorkerRpc } from "./rpc-server.ts";
import { Terminal, stdoutSink } from "./terminal.ts";

// The worker entrypoint (DESIGN §14).
//
// Two things are load-bearing here and both are tests rather than intentions: the
// environment is read field by field against the declared names, so no ambient
// variable is ever captured, and the only file this process reads for
// configuration is the installed package's own — never a target directory's `.env`.

// `fileURLToPath` rather than `new URL(...).pathname`: the pathname keeps its percent
// encoding, so an install under a directory with a space or a CJK name would resolve to a
// path that does not exist, and `readJson` would report "no installed defaults" instead of
// the real problem - a silently empty configuration is the worst failure this process can
// have, because it still boots and still prints a pairing code.
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REQUIRED_NODE_VERSION = "24.18.0";

function declaredEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const field of BOOT_CONFIG_FIELDS) picked[field] = env[field];
  return picked;
}

function readJson(target: string): Record<string, string | undefined> {
  if (!existsSync(target)) return {};
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8")) as JsonValue;
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, JsonValue>;
  const defaults: Record<string, string | undefined> = {};
  for (const field of BOOT_CONFIG_FIELDS) {
    const value = record[field];
    if (typeof value === "string") defaults[field] = value;
    if (typeof value === "number") defaults[field] = String(value);
  }
  return defaults;
}

// How often the job runner looks at the queue. This is a latency choice of this process, not a
// resource limit: §14's "measure it into the profile" rule covers the numbers that decide whether
// work may run (the queue wait and the attempt budget), and both reach the runner through the
// profile. Nothing is scheduled per second here, so a restart cannot lose a job by missing a beat -
// the queue is a table, and the next turn reads whatever is in it.
const RUNNER_POLL_MS = 250;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const terminal = new Terminal(stdoutSink(process.stdout));
  const flags = argv.filter((entry) => entry.startsWith("--"));
  const positional = argv.filter((entry) => !entry.startsWith("--"));
  // `--doctor` is the read-only mode: report and leave. It never migrates a
  // database it was not asked to open, and it never repairs a host (§14).
  const doctorOnly = flags.includes("--doctor");
  const packageRoot = positional[0] ?? PACKAGE_ROOT;
  const booted = await bootWorker({
    env: declaredEnv(process.env),
    installedDefaults: readJson(path.join(packageRoot, "infra", "config", "installed-defaults.json")),
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: process.versions.node, requiredNodeVersion: REQUIRED_NODE_VERSION },
  });
  if (!booted.ok) {
    // Reasons only: a configuration failure must not echo the value it rejected.
    for (const reason of booted.error.reasons) terminal.print("config-error", reason);
    return booted.error.kind === "config" ? 78 : 73;
  }
  const worker = booted.value;

  const report = await worker.doctor();
  terminal.print("worker", `ready=${String(report.ready)} degraded=${String(report.degraded)}`);
  for (const check of report.checks) {
    terminal.print("check", `${check.name}=${check.state} ${check.reasons.join(",")}`);
  }
  if (doctorOnly) {
    await worker.shutdown();
    return report.ready ? 0 : 1;
  }

  const started = await startWorkerRpc(worker);
  if (!started.ok) {
    terminal.print("rpc-error", started.error.reason);
    await worker.shutdown();
    return 65;
  }
  terminal.print("rpc", `listening=${path.basename(started.value.socketPath)}`);
  // DESIGN §14: the one-time pairing code is shown in the operator's own terminal,
  // beside the URL that does not contain it. This is the only place the value leaves
  // the worker's memory, and it is a terminal write rather than a response body, so a
  // web request cannot ask for a code at all.
  const pairing = worker.pairingCode();
  terminal.print(
    "pair",
    `code=${pairing.token} url=http://${worker.config.host}:${String(worker.config.port)} expires=${pairing.expiresAt}`,
  );

  // §11's executor half, now that a `queued` row has someone to pick it up (issue #57): the doors
  // create work, this loop runs it. One job per turn and only after the previous turn settled - a
  // Builder child holds role staging, and two of them in the same directory is a race §5's
  // per-(project,class) promise does not cover.
  //
  // `RUNNER_POLL_MS` is a scheduler tick, not a resource limit: §14's "measure it into the profile"
  // rule is about the numbers that decide whether work may run (the queue wait, the attempt budget),
  // and both of those come from the profile through `generationContext`. How often the worker looks
  // is a latency choice of this process, and it is written where the operator can see it.
  let stopPump = false;
  const pump = async (): Promise<void> => {
    while (!stopPump) {
      const turn = await worker.runJobs();
      if (!turn.ok) {
        terminal.print("runner", `error=${turn.error.reason}`);
      } else {
        // One line per non-idle turn. A terminal reading that names the job and what became of it
        // is what the restart tests and an operator's `tail -f` both read, so the shape is stated
        // per kind rather than assembled from optional fields.
        const outcome = turn.value;
        if (outcome.kind === "succeeded") {
          terminal.print("runner", `succeeded job=${outcome.jobId} candidate=${outcome.candidateId} attempt=${String(outcome.attempt)}`);
        } else if (outcome.kind === "cancelled") {
          terminal.print("runner", `cancelled job=${outcome.jobId}`);
        } else if (outcome.kind !== "idle") {
          terminal.print("runner", `${outcome.kind} job=${outcome.jobId} reason=${outcome.reason}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RUNNER_POLL_MS));
    }
  };
  const pumping = pump();

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      stopPump = true;
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  // The turn in flight gets to settle: a job cut off between claim and settle would come back as
  // `interrupted`, which is true but slower to read than the answer the work already produced.
  await pumping;
  await started.value.close();
  await worker.shutdown();
  terminal.print("worker", "stopped");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
