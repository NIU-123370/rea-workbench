import {
  BOOT_CONFIG_FIELDS,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  webListenConfigSchema,
  bootConfigSchema as BOOT_STRICT,
} from "../contracts/boot.ts";
import type { BootConfigField, BootConfigWire, ProfileWire, WebListenConfigWire } from "../contracts/boot.ts";
import { profileSchema } from "../contracts/boot.ts";
import { parseStrict } from "../contracts/parse.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";

// BootConfig, parsed once per process (DESIGN §14).
//
// Three properties make this a gate rather than a loader: an unsafe value is
// reported by field name and safe reason only, so a secret inside a path or URL
// never travels back out; the input is an explicit record of the seven WB_* names,
// so no caller can hand the whole ambient environment to it; and the
// resolved config is a closed shape, so nothing ambient survives into it.

export type BootConfig = BootConfigWire;

export type ConfigFailure = {
  field: BootConfigField;
  reason: string;
};

export type ConfigInput = {
  // Only the declared keys are read. A missing required key is a failure naming it, not
  // a default invented here — except the two fields §14 documents a default for.
  env: Readonly<Record<string, string | undefined>>;
  // Installed-package declarations, overridden by explicit process config.
  installedDefaults: Readonly<Record<string, string | undefined>>;
  // Probed by the composition root, never by this module: it has no filesystem
  // access, so it cannot read a target directory's `.env`.
  filesystem: {
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    isSocket(path: string): boolean;
    isWriteable(path: string): boolean;
    isPrivateDirectory(path: string): boolean;
  };
};

export type ResolvedBoot =
  | { kind: "ok"; config: BootConfig; sources: Record<BootConfigField, "process" | "installed" | "default"> }
  | { kind: "invalid"; failures: ConfigFailure[] };

// Absolute, and already in normalised form: a `.` or `..` segment would mean the
// caller handed over a path whose meaning depends on a working directory, which a
// boot-time path must not.
function absolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  const segments = value.slice(1).split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function loopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Locality is a literal, not a name to resolve: `localhost` would put DNS in the
  // middle of a security decision.
  return (
    url.protocol === "http:" &&
    url.hostname === LOOPBACK_HOST &&
    url.username === "" &&
    url.password === "" &&
    url.port !== ""
  );
}

export function resolveBootConfig(input: ConfigInput): ResolvedBoot {
  const failures: ConfigFailure[] = [];
  const sources = {} as Record<BootConfigField, "process" | "installed" | "default">;
  const raw = {} as Record<BootConfigField, string>;

  for (const field of BOOT_CONFIG_FIELDS) {
    const explicit = input.env[field];
    const installed = input.installedDefaults[field];
    // An explicitly empty value is a mistake, not an absence: silently falling
    // back to a default here is how `WB_HOST=""` ends up binding something else.
    // The model endpoint is the one field where empty *is* the declared answer,
    // because "generation is off" is a configuration, not a missing value (§14).
    if (explicit === "" && field !== "WB_MODEL_ENDPOINT") failures.push({ field, reason: "present-but-empty" });
    else if (typeof explicit === "string" && explicit.length > 0) {
      raw[field] = explicit;
      sources[field] = "process";
      continue;
    }
    if (installed === "") failures.push({ field, reason: "installed-default-empty" });
    else if (typeof installed === "string" && installed.length > 0) {
      raw[field] = installed;
      sources[field] = "installed";
      continue;
    }
    if (field === "WB_HOST") {
      raw[field] = LOOPBACK_HOST;
      sources[field] = "default";
      continue;
    }
    if (field === "WB_PORT") {
      raw[field] = String(DEFAULT_PORT);
      sources[field] = "default";
      continue;
    }
    if (field === "WB_MODEL_ENDPOINT") {
      // Optional by design: absent means the generation capability is off.
      raw[field] = "";
      sources[field] = "default";
      continue;
    }
    failures.push({ field, reason: "required-and-no-installed-default" });
  }

  if (raw["WB_HOST"] !== LOOPBACK_HOST) {
    failures.push({
      field: "WB_HOST",
      reason: raw["WB_HOST"] === undefined ? "missing" : "only-the-loopback-literal-is-accepted",
    });
  }

  const portText = raw["WB_PORT"] ?? "";
  const port = Number(portText);
  if (!/^[1-9]\d*$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    failures.push({ field: "WB_PORT", reason: "decimal-integer-in-1..65535-required" });
  }

  const dataDir = raw["WB_DATA_DIR"] ?? "";
  if (dataDir === "") failures.push({ field: "WB_DATA_DIR", reason: "required-and-no-installed-default" });
  if (!absolutePath(dataDir)) {
    failures.push({ field: "WB_DATA_DIR", reason: "absolute-normalised-path-required" });
  } else if (!input.filesystem.isDirectory(dataDir)) {
    // §14: the workbench never creates arbitrary ancestors on an operator's
    // behalf, so a missing directory is a stated problem, not a mkdir.
    failures.push({ field: "WB_DATA_DIR", reason: "directory-missing-or-not-a-directory" });
  } else if (!input.filesystem.isPrivateDirectory(dataDir)) {
    failures.push({ field: "WB_DATA_DIR", reason: "directory-is-group-or-world-accessible" });
  } else if (!input.filesystem.isWriteable(dataDir)) {
    failures.push({ field: "WB_DATA_DIR", reason: "directory-not-writeable" });
  }

  const entrypoint = raw["WB_REA_ENTRYPOINT"] ?? "";
  if (!absolutePath(entrypoint) || !input.filesystem.isFile(entrypoint)) {
    failures.push({ field: "WB_REA_ENTRYPOINT", reason: "absolute-existing-file-path-required" });
  }

  const modelEndpoint = raw["WB_MODEL_ENDPOINT"] ?? "";
  if (modelEndpoint !== "" && !loopbackHttpUrl(modelEndpoint)) {
    failures.push({
      field: "WB_MODEL_ENDPOINT",
      reason: "loopback-http-url-without-userinfo-required",
    });
  }

  const profile = raw["WB_SANDBOX_PROFILE"] ?? "";
  if (profile.length === 0 || profile.includes("/") || profile.includes("..")) {
    // A profile id is a lookup key only: no path, no traversal, no Docker argument.
    failures.push({ field: "WB_SANDBOX_PROFILE", reason: "installed-profile-id-only" });
  }

  const socket = raw["WB_BROKER_SOCKET"] ?? "";
  if (!absolutePath(socket)) {
    failures.push({ field: "WB_BROKER_SOCKET", reason: "absolute-socket-path-required" });
  } else if (/^[a-z]+:\/\//i.test(socket)) {
    failures.push({ field: "WB_BROKER_SOCKET", reason: "tcp-url-is-not-a-broker-socket" });
  } else if (!input.filesystem.isSocket(socket)) {
    failures.push({ field: "WB_BROKER_SOCKET", reason: "path-is-not-a-socket" });
  }

  if (failures.length > 0) {
    return { kind: "invalid", failures: dedupeFailures(failures) };
  }

  const candidate = {
    host: raw["WB_HOST"],
    port,
    dataDir,
    reaEntrypoint: entrypoint,
    modelEndpoint: modelEndpoint === "" ? null : modelEndpoint,
    sandboxProfile: profile,
    brokerSocket: socket,
  };
  const checked = parseStrict(BOOT_STRICT, candidate);
  if (!checked.ok) {
    return {
      kind: "invalid",
      failures: checked.error.issues.map((issue) => ({
        field: (issue.path[0] === "port" ? "WB_PORT" : "WB_HOST") as BootConfigField,
        reason: "resolved-shape-rejected",
      })),
    };
  }
  return { kind: "ok", config: checked.value, sources };
}

function dedupeFailures(failures: readonly ConfigFailure[]): ConfigFailure[] {
  const seen = new Set<string>();
  const unique: ConfigFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.field}:${failure.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

export function configFieldNames(failures: readonly ConfigFailure[]): string[] {
  return [...new Set(failures.map((failure) => failure.field))].sort();
}

export type WebListenConfig = WebListenConfigWire;

// The only three §14 fields the web process reads. The other four are the worker's,
// the broker's and the adapter's business, and reading them here would put a host
// path or a provider endpoint inside a process that must not know about either.
const WEB_LISTEN_FIELDS: readonly BootConfigField[] = ["WB_HOST", "WB_PORT", "WB_DATA_DIR"];

// The web half of §14. Same three fields, same precedence (process config over the
// installed package's declaration over the documented default), same rule that an
// explicitly empty value is a mistake rather than an absence — and no filesystem
// probes: §14 gives WB_DATA_DIR's privacy, writability and lock to the worker
// composition root, and the API process must not acquire a stake in that directory.
export function resolveWebListen(input: {
  env: Readonly<Record<string, string | undefined>>;
  installedDefaults: Readonly<Record<string, string | undefined>>;
}): { kind: "ok"; config: WebListenConfig } | { kind: "invalid"; failures: ConfigFailure[] } {
  const picked: Partial<Record<BootConfigField, string>> = {};
  for (const field of WEB_LISTEN_FIELDS) {
    const explicit = input.env[field];
    const installed = input.installedDefaults[field];
    if (explicit === "") picked[field] = "";
    else if (typeof explicit === "string" && explicit.length > 0) picked[field] = explicit;
    else if (typeof installed === "string" && installed.length > 0) picked[field] = installed;
  }
  const host = picked.WB_HOST ?? LOOPBACK_HOST;
  const portText = picked.WB_PORT ?? String(DEFAULT_PORT);
  const dataDir = picked.WB_DATA_DIR ?? "";
  const failures: ConfigFailure[] = [];
  if (host !== LOOPBACK_HOST) failures.push({ field: "WB_HOST", reason: "only-the-loopback-literal-is-accepted" });
  if (picked.WB_HOST === "") failures.push({ field: "WB_HOST", reason: "present-but-empty" });
  if (picked.WB_PORT === "") failures.push({ field: "WB_PORT", reason: "present-but-empty" });
  const port = Number(portText);
  if (!/^[1-9]\d*$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    failures.push({ field: "WB_PORT", reason: "decimal-integer-in-1..65535-required" });
  }
  if (dataDir === "") failures.push({ field: "WB_DATA_DIR", reason: "required-and-no-installed-default" });
  else if (!absolutePath(dataDir)) failures.push({ field: "WB_DATA_DIR", reason: "absolute-normalised-path-required" });
  if (failures.length > 0) return { kind: "invalid", failures: dedupeFailures(failures) };
  const checked = parseStrict(webListenConfigSchema, { host, port, dataDir });
  if (!checked.ok) {
    return { kind: "invalid", failures: [{ field: "WB_PORT", reason: "resolved-shape-rejected" }] };
  }
  return { kind: "ok", config: checked.value };
}

export function toSafeJson(config: BootConfig): JsonValue {
  // Health and doctor output shape: field names and the effective numbers only.
  return {
    host: config.host,
    port: config.port,
    sandboxProfile: config.sandboxProfile,
    modelEndpointConfigured: config.modelEndpoint !== null,
  };
}

export type ProfileEntry = {
  profile: ProfileWire;
  available: boolean;
  unavailableReasons: string[];
};

// The loader (composition root) supplies a label it derived from the file, because
// path handling belongs to the adapter side of the boundary (§3).
export type ProfileSource = { label: string; json: JsonValue };

export type RegistryHostFacts = {
  // Reported by the broker/adapter layer: the registry owns the schema, the host
  // owns the truth about whether it can actually enforce a sandbox.
  canEnforceSandbox: boolean;
  reaPackageDigest: string | null;
  supportedPlatform: boolean;
};

export class ProfileRegistry {
  readonly entries: Map<string, ProfileEntry> = new Map();

  constructor(profiles: readonly ProfileSource[], facts: RegistryHostFacts) {
    for (const entry of profiles) {
      const parsed = profileSchema.safeParse(entry.json);
      if (!parsed.success) {
        // An unknown dialect or a missing limit is stated as an unavailable
        // profile, never repaired by guessing a value.
        this.entries.set(`unreadable:${entry.label}`, {
          profile: FALLBACK_PROFILE,
          available: false,
          unavailableReasons: [`profile-schema:${parsed.error.issues.map((issue) => issue.path.map(String).join(".")).join(",")}`],
        });
        continue;
      }
      const reasons: string[] = [];
      if (!facts.supportedPlatform) reasons.push("host-platform-unverified-for-sandbox");
      if (!facts.canEnforceSandbox) reasons.push("host-cannot-enforce-sandbox");
      if (facts.reaPackageDigest === null) reasons.push("installed-rea-digest-unknown");
      else if (facts.reaPackageDigest !== parsed.data.reaPackageDigest) reasons.push("rea-package-digest-mismatch");
      this.entries.set(parsed.data.id, {
        profile: parsed.data,
        available: reasons.length === 0,
        unavailableReasons: reasons,
      });
    }
  }

  get(id: string): ProfileEntry | null {
    return this.entries.get(id) ?? null;
  }

  availableFor(id: string): Result<ProfileWire, string[]> {
    const entry = this.get(id);
    if (entry === null) return { ok: false, error: ["profile-not-installed"] };
    if (!entry.available) return { ok: false, error: entry.unavailableReasons };
    return { ok: true, value: entry.profile };
  }

  healthView(): JsonValue[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.profile.id,
      reaPackageDigest: entry.profile.reaPackageDigest,
      browserImageDigest: entry.profile.browserImageDigest,
      browserVersion: entry.profile.browserVersion,
      limits: entry.profile.limits,
      networkPolicyId: entry.profile.networkPolicyId,
      available: entry.available,
      unavailableReasons: entry.unavailableReasons,
    }));
  }
}

const FALLBACK_PROFILE: ProfileWire = {
  id: "unreadable-profile",
  schemaVersion: 1,
  reaPackageDigest: "0".repeat(64),
  reaContainerEntrypoint: "unreadable",
  browserImageDigest: "0".repeat(64),
  browserVersion: "unreadable",
  limits: {
    cpuCores: 1,
    memoryBytes: 1,
    pids: 1,
    diskBytes: 1,
    maxExpandedBytes: 1,
    queueWaitMs: 1,
    timeoutMs: 1,
    // Same placeholder convention as the seven numbers above: this object is only ever attached to
    // an entry created with `available: false`, so `availableFor` refuses it and no runtime path
    // reads a limit out of it. It is the shape the type asks for, not a budget anyone may spend.
    maxGenerationAttempts: 1,
  },
  networkPolicyId: "unreadable",
};

