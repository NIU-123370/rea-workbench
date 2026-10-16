import { describe, expect, it } from "vitest";

import {
  ProfileRegistry,
  resolveBootConfig,
  toSafeJson,
} from "../../packages/application/boot-config.ts";
import type { ConfigInput } from "../../packages/application/boot-config.ts";
import { runDoctor } from "../../packages/application/doctor.ts";
import { ownershipProvable } from "../../packages/application/recovery.ts";
import { Terminal } from "../../apps/worker/terminal.ts";
import type { LeaseRow } from "../../packages/application/ports.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";

// DESIGN §14 is the only authority for WB_* parsing, the ProfileRegistry and what
// the doctor may say. The cases below are the ones a reviewer would try first:
// does a bad value leak, does a default hide a mistake, does a profile the host
// cannot enforce read as available?

const SECRET_PATH = "/home/operator/hunter2-value/rea.mjs";

const baseEnv = {
  WB_HOST: "127.0.0.1",
  WB_PORT: "4310",
  WB_DATA_DIR: "/var/lib/rea-workbench",
  WB_REA_ENTRYPOINT: "/opt/rea/scripts/rea.mjs",
  WB_MODEL_ENDPOINT: "",
  WB_SANDBOX_PROFILE: "har-capture",
  WB_BROKER_SOCKET: "/run/rea-workbench/broker.sock",
};

const fs = {
  isDirectory: (target: string) => target === "/var/lib/rea-workbench",
  isFile: (target: string) => target === "/opt/rea/scripts/rea.mjs",
  isSocket: (target: string) => target === "/run/rea-workbench/broker.sock",
  isWriteable: () => true,
  isPrivateDirectory: () => true,
};

function resolve(env: Record<string, string | undefined>, overrides: Partial<ConfigInput["filesystem"]> = {}) {
  return resolveBootConfig({
    env,
    installedDefaults: {},
    filesystem: { ...fs, ...overrides },
  });
}

function profileJson(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    id: "har-capture",
    schemaVersion: 1,
    reaPackageDigest: "a".repeat(64),
    reaContainerEntrypoint: "/usr/local/bin/rea",
    browserImageDigest: "b".repeat(64),
    browserVersion: "141.0.7390.107",
    limits: {
      cpuCores: 2,
      memoryBytes: 2147483648,
      pids: 128,
      diskBytes: 10737418240,
      maxExpandedBytes: 67108864,
      queueWaitMs: 30000,
      timeoutMs: 120000,
    },
    networkPolicyId: "deny-egress",
    ...overrides,
  };
}

describe("BootConfig resolution (DESIGN §14)", () => {
  it("accepts the documented defaults when nothing is declared", () => {
    const resolved = resolve({
      WB_DATA_DIR: baseEnv["WB_DATA_DIR"],
      WB_REA_ENTRYPOINT: baseEnv["WB_REA_ENTRYPOINT"],
      WB_SANDBOX_PROFILE: baseEnv["WB_SANDBOX_PROFILE"],
      WB_BROKER_SOCKET: baseEnv["WB_BROKER_SOCKET"],
    });
    expect(resolved.kind).toBe("ok");
    if (resolved.kind !== "ok") return;
    expect(resolved.config.host).toBe("127.0.0.1");
    expect(resolved.config.port).toBe(4310);
    expect(resolved.config.modelEndpoint).toBeNull();
    expect(resolved.sources.WB_HOST).toBe("default");
    expect(resolved.sources.WB_DATA_DIR).toBe("process");
  });

  it("lets explicit process config override the installed package's declaration", () => {
    const resolved = resolveBootConfig({
      env: { ...baseEnv, WB_PORT: "4400", WB_DATA_DIR: undefined },
      installedDefaults: { WB_PORT: "4310", WB_DATA_DIR: "/var/lib/rea-workbench" },
      filesystem: fs,
    });
    expect(resolved.kind).toBe("ok");
    if (resolved.kind !== "ok") return;
    expect(resolved.config.port).toBe(4400);
    expect(resolved.sources.WB_PORT).toBe("process");
    // An installed default is still a default, not an override of the operator.
    // The installed default filled a value the process did not declare.
    expect(resolved.sources.WB_DATA_DIR).toBe("installed");
    expect(resolved.config.dataDir).toBe("/var/lib/rea-workbench");
  });

  it.each([
    ["0.0.0.0", "all-interfaces"],
    ["localhost", "a-name-to-resolve"],
    ["127.0.0.1:4310", "concatenated-host"],
    ["", "empty"],
  ])("refuses the host %s", (host) => {
    const resolved = resolve({ ...baseEnv, WB_HOST: host });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "ok") {
      expect(resolved.failures.map((failure) => failure.field)).toContain("WB_HOST");
    }
  });

  it("refuses a port outside the range and a non-decimal port", () => {
    expect(resolve({ ...baseEnv, WB_PORT: "0" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_PORT: "65536" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_PORT: "04310" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_PORT: "4310 " }).kind).toBe("invalid");
  });

  it("requires an absolute, normalised, existing and private data directory", () => {
    expect(resolve({ ...baseEnv, WB_DATA_DIR: "relative/dir" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_DATA_DIR: "/var/lib/rea-workbench/../rea-workbench" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_DATA_DIR: "/tmp/x" }).kind).toBe("invalid");
    const notPrivate = resolve(baseEnv, { isPrivateDirectory: () => false });
    expect(notPrivate.kind).toBe("invalid");
    if (notPrivate.kind === "invalid") {
      expect(notPrivate.failures.map((failure) => failure.reason)).toContain("directory-is-group-or-world-accessible");
    }
  });

  it("refuses a broker socket that is a TCP URL, missing, or not a socket", () => {
    expect(resolve({ ...baseEnv, WB_BROKER_SOCKET: "tcp://127.0.0.1:9999" }).kind).toBe("invalid");
    expect(resolve({ ...baseEnv, WB_BROKER_SOCKET: "/run/rea-workbench/nope.sock" }).kind).toBe("invalid");
  });

  it("refuses a profile id that carries a path", () => {
    const resolved = resolve({ ...baseEnv, WB_SANDBOX_PROFILE: "../escape" });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind === "invalid") {
      expect(resolved.failures.map((failure) => failure.reason)).toContain("installed-profile-id-only");
    }
  });

  it("treats an explicitly empty optional endpoint as 'generation is off', and an empty host as a mistake", () => {
    const off = resolve({ ...baseEnv, WB_MODEL_ENDPOINT: "" });
    expect(off.kind).toBe("ok");
    if (off.kind === "ok") expect(off.config.modelEndpoint).toBeNull();
    const emptyHost = resolve({ ...baseEnv, WB_HOST: "" });
    expect(emptyHost.kind).toBe("invalid");
    if (emptyHost.kind === "invalid") {
      expect(emptyHost.failures.map((failure) => failure.reason)).toContain("present-but-empty");
    }
  });

  it.each([
    ["http://localhost:4321/v1", "a name instead of a literal loopback"],
    ["https://127.0.0.1:4321/v1", "not plain loopback http"],
    ["http://user:hunter2@127.0.0.1:4321/v1", "credentials in the URL"],
    ["http://10.0.0.8:4321/v1", "a private address that is not loopback"],
    ["http://127.0.0.1", "no port to connect to"],
  ])("refuses the model endpoint %s", (url) => {
    const resolved = resolve({ ...baseEnv, WB_MODEL_ENDPOINT: url });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind === "invalid") {
      expect(resolved.failures.map((failure) => failure.reason)).toContain("loopback-http-url-without-userinfo-required");
    }
  });

  it("accepts a loopback model endpoint and reports it by name only", () => {
    const resolved = resolve({ ...baseEnv, WB_MODEL_ENDPOINT: "http://127.0.0.1:4321/v1" });
    expect(resolved.kind).toBe("ok");
    if (resolved.kind !== "ok") return;
    expect(resolved.config.modelEndpoint).toBe("http://127.0.0.1:4321/v1");
    expect(JSON.stringify(toSafeJson(resolved.config))).not.toContain("4321");
    expect(toSafeJson(resolved.config)).toEqual({
      host: "127.0.0.1",
      port: 4310,
      sandboxProfile: "har-capture",
      modelEndpointConfigured: true,
    });
  });

  it("names the field and the reason, never the value it rejected", () => {
    const resolved = resolve({ ...baseEnv, WB_REA_ENTRYPOINT: SECRET_PATH });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") return;
    const serialised = JSON.stringify(resolved.failures);
    expect(serialised).not.toContain("hunter2-value");
    expect(serialised).not.toContain(SECRET_PATH);
    expect(serialised).toContain("WB_REA_ENTRYPOINT");
    expect(serialised).toContain("absolute-existing-file-path-required");
  });

  it("reports every failing field at once and deduplicates the same reason", () => {
    const resolved = resolve({
      WB_HOST: "0.0.0.0",
      WB_PORT: "99999",
      WB_DATA_DIR: "relative",
      WB_REA_ENTRYPOINT: "also-relative",
      WB_SANDBOX_PROFILE: "",
      WB_BROKER_SOCKET: "tcp://x",
    });
    expect(resolved.kind).toBe("invalid");
    if (resolved.kind !== "invalid") return;
    const fields = new Set(resolved.failures.map((failure) => failure.field));
    expect(fields.has("WB_HOST")).toBe(true);
    expect(fields.has("WB_PORT")).toBe(true);
    expect(fields.has("WB_DATA_DIR")).toBe(true);
    expect(fields.has("WB_BROKER_SOCKET")).toBe(true);
    const duplicate = resolved.failures.filter((failure) => failure.reason === "only-the-loopback-literal-is-accepted");
    expect(duplicate.length).toBe(1);
  });

});

describe("ProfileRegistry (§14)", () => {
  const linuxHost = { supportedPlatform: true, canEnforceSandbox: true, reaPackageDigest: "a".repeat(64) };

  it("marks a complete profile available when the host can enforce it", () => {
    const registry = new ProfileRegistry([{ label: "har-capture", json: profileJson() }], linuxHost);
    const entry = registry.get("har-capture");
    expect(entry?.available).toBe(true);
    expect(entry?.unavailableReasons).toEqual([]);
  });

  it("refuses to call a profile available on a host that cannot enforce the sandbox", () => {
    const registry = new ProfileRegistry([{ label: "har-capture", json: profileJson() }], {
      ...linuxHost,
      supportedPlatform: false,
      canEnforceSandbox: false,
    });
    const entry = registry.get("har-capture");
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReasons).toContain("host-platform-unverified-for-sandbox");
    expect(entry?.unavailableReasons).toContain("host-cannot-enforce-sandbox");
  });

  it("refuses a profile whose package digest is not the installed one", () => {
    const registry = new ProfileRegistry([{ label: "har-capture", json: profileJson() }], {
      ...linuxHost,
      reaPackageDigest: "c".repeat(64),
    });
    expect(registry.get("har-capture")?.unavailableReasons).toContain("rea-package-digest-mismatch");
  });

  it("never guesses a missing limit: an incomplete profile is uninstalled, not defaulted", () => {
    const broken = profileJson() as { limits: Record<string, JsonValue> };
    delete broken.limits.memoryBytes;
    const registry = new ProfileRegistry([{ label: "har-capture", json: broken as unknown as JsonValue }], linuxHost);
    // The registry cannot read an id out of a document that failed to parse, so
    // the profile is simply not installed under that name and nothing resolves.
    expect(registry.get("har-capture")).toBeNull();
    expect(registry.availableFor("har-capture").ok).toBe(false);
    const listed = registry.healthView();
    expect(listed.length).toBe(1);
    expect(JSON.stringify(listed)).toContain("profile-schema:limits.memoryBytes");
    expect(JSON.stringify(listed)).toContain("\"available\":false");
  });

  it("reports profiles by id, digest and numbers without any host path", () => {
    const registry = new ProfileRegistry([{ label: "har-capture", json: profileJson() }], linuxHost);
    const view = JSON.stringify(registry.healthView());
    expect(view).not.toContain("/usr/local/bin");
    expect(view).not.toContain("/var/lib");
    expect(view).toContain("deny-egress");
    expect(view).toContain("\"pids\":128");
  });

  it("an uninstalled profile id is a stated refusal, not a default profile", () => {
    const registry = new ProfileRegistry([], linuxHost);
    const asked = registry.availableFor("har-capture");
    expect(asked.ok).toBe(false);
    if (!asked.ok) expect(asked.error).toEqual(["profile-not-installed"]);
  });
});

describe("doctor (§14) and lease ownership (§11)", () => {
  it("aggregates states and keeps a failed check from reading as ready", async () => {
    const report = await runDoctor([
      { name: "toolchain", run: () => ({ state: "ok", facts: { nodeMajor: "24.18.0" } }) },
      { name: "broker-socket", run: () => ({ state: "failed", reasons: ["broker-socket-absent-or-not-a-socket"] }) },
      { name: "sandbox-profile", run: () => ({ state: "degraded", reasons: ["host-cannot-enforce-sandbox"] }) },
    ]);
    expect(report.ready).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.checks.map((check) => check.state)).toEqual(["ok", "failed", "degraded"]);
  });

  it("a throwing probe becomes a failure with a sanitised reason", async () => {
    const report = await runDoctor([
      {
        name: "storage-layout",
        run: () => {
          throw new Error("/home/operator/secret/path is unwritable");
        },
      },
    ]);
    expect(report.ready).toBe(false);
    expect(report.checks[0]?.reasons).toEqual(["probe-threw:Error"]);
  });

  it("drops a reason that looks like a path instead of printing it", async () => {
    const report = await runDoctor([
      { name: "limits", run: () => ({ state: "failed", reasons: ["/home/operator/rea/data", "limits-unknown-no-profile"] }) },
    ]);
    expect(report.checks[0]?.reasons).toEqual(["unprintable-reason", "limits-unknown-no-profile"]);
  });

  it("an empty check list is the doctor failing, not passing", async () => {
    const report = await runDoctor([]);
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual([]);
  });

  it("keeps a lease whose ownership proof does not name this job", () => {
    const lease: LeaseRow = {
      id: "11111111-1111-4111-8111-111111111111" as LeaseRow["id"],
      jobId: "22222222-2222-4222-8222-222222222222" as LeaseRow["jobId"],
      kind: "har-staging",
      resourceIdentityJson: {},
      ownershipProofJson: { mintedBy: "har-import", jobId: "33333333-3333-4333-8333-333333333333" },
      cleanupState: "failed",
      lastErrorJson: null,
      retryAt: null,
      retryCount: 1,
    };
    // A proof naming another job is unknown ownership: recovery keeps the record.
    expect(ownershipProvable(lease)).toBe(false);
    expect(ownershipProvable({ ...lease, ownershipProofJson: { mintedBy: "har-import", jobId: lease.jobId } })).toBe(true);
    expect(ownershipProvable({ ...lease, ownershipProofJson: "/tmp/stale-1" })).toBe(false);
  });
});

describe("terminal output (§12.1 with §14)", () => {
  it("writes an ordinary status line to the injected sink", () => {
    const written: string[] = [];
    const terminal = new Terminal({ writeLine: (text) => written.push(text) });
    expect(terminal.print("worker", "ready=true degraded=false")).toBe(true);
    expect(written).toEqual(["worker ready=true degraded=false\n"]);
  });

  it("refuses to print a credential-shaped line even after filtering", () => {
    const written: string[] = [];
    const terminal = new Terminal({ writeLine: (text) => written.push(text) });
    expect(terminal.print("pair", "Bearer supersecrettokenvalue")).toBe(false);
    expect(written).toEqual([]);
    expect(terminal.lines).toEqual(["pair [suppressed]"]);
  });

  it("keeps the number of attempted lines visible without the content", () => {
    const terminal = new Terminal({ writeLine: () => undefined });
    terminal.print("pair", "token=abc12345");
    terminal.print("check", "toolchain=ok");
    expect(terminal.lines.length).toBe(2);
    expect(JSON.stringify(terminal.lines)).not.toContain("abc12345");
  });
});
