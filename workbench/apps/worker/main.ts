import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

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

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
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

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
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
