import { z } from "zod";

// Boot and profile wire shapes (DESIGN §14 — the only design authority for WB_*
// configuration, ProfileRegistry and local session establishment).
//
// Nothing in this file may widen what a value can be: every field is parsed from
// `unknown`, and the failure type carries a field name and a safe reason only, so
// a secret that happens to live in a path or a URL cannot be echoed back.

export const BOOT_CONFIG_FIELDS = [
  "WB_HOST",
  "WB_PORT",
  "WB_DATA_DIR",
  "WB_REA_ENTRYPOINT",
  "WB_MODEL_ENDPOINT",
  "WB_SANDBOX_PROFILE",
  "WB_BROKER_SOCKET",
] as const;

export type BootConfigField = (typeof BOOT_CONFIG_FIELDS)[number];

// First release accepts this literal address and nothing else: no 0.0.0.0, no
// non-loopback, no concatenated hostname, and no DNS to decide locality.
export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4310;

export const bootConfigFailureSchema = z.strictObject({
  field: z.enum(BOOT_CONFIG_FIELDS),
  reason: z.string().min(1),
});

export const bootConfigSchema = z.strictObject({
  host: z.literal(LOOPBACK_HOST),
  port: z.int().min(1).max(65535),
  dataDir: z.string(),
  reaEntrypoint: z.string(),
  // Absent means the generation capability is off; the workbench never falls
  // back to an implicit cloud endpoint.
  modelEndpoint: z.string().nullable(),
  sandboxProfile: z.string().min(1),
  brokerSocket: z.string(),
});

export type BootConfigWire = z.infer<typeof bootConfigSchema>;
export type BootConfigFailureWire = z.infer<typeof bootConfigFailureSchema>;

export const profileLimitsSchema = z.strictObject({
  cpuCores: z.number().positive(),
  memoryBytes: z.int().positive(),
  pids: z.int().positive(),
  diskBytes: z.int().positive(),
  maxExpandedBytes: z.int().positive(),
  queueWaitMs: z.int().positive(),
  timeoutMs: z.int().positive(),
});

// An explicit profile is the only source of resource numbers: the runtime never
// guesses a limit it was not given (§14 "资源初值须由真实 fixture 测量后随 profile 锁定").
export const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  schemaVersion: z.literal(1),
  reaPackageDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reaContainerEntrypoint: z.string().min(1),
  browserImageDigest: z.string().regex(/^[0-9a-f]{64}$/),
  browserVersion: z.string().min(1),
  limits: profileLimitsSchema,
  networkPolicyId: z.string().min(1),
});

export type ProfileLimitsWire = z.infer<typeof profileLimitsSchema>;
export type ProfileWire = z.infer<typeof profileSchema>;

export const healthProfileSchema = z.strictObject({
  id: profileSchema.shape.id,
  reaPackageDigest: profileSchema.shape.reaPackageDigest,
  browserImageDigest: profileSchema.shape.browserImageDigest,
  browserVersion: profileSchema.shape.browserVersion,
  limits: profileLimitsSchema,
  networkPolicyId: profileSchema.shape.networkPolicyId,
  available: z.boolean(),
  // Named, safe reasons: never a host path, never the whole configuration.
  unavailableReasons: z.array(z.string().min(1)),
});

export type HealthProfile = z.infer<typeof healthProfileSchema>;
