import { z } from "zod";

import { digestSchema, nonEmptyString } from "./primitives.ts";

// GET /health (DESIGN §8) plus the resolved configuration surface (§14).
// Health reports profile IDs, image digests, effective numeric limits and
// capability names. It deliberately has no field that can carry a host path,
// the container entrypoint, the REA package root or any credential: upstream
// `server_identity.package` exposes `root_path` and `build_commit`, and
// `reaContainerEntrypoint` is a host absolute path — none of them belong here.

export const profileLimitsSchema = z.strictObject({
  cpuCores: z.int().positive(),
  memoryBytes: z.int().positive(),
  pids: z.int().positive(),
  diskBytes: z.int().positive(),
  maxExpandedBytes: z.int().positive(),
  queueWaitMs: z.int().nonnegative(),
  timeoutMs: z.int().nonnegative(),
});

export const effectiveProfileSchema = z.strictObject({
  id: nonEmptyString,
  schemaVersion: z.int().positive(),
  reaPackageDigest: digestSchema,
  browserImageDigest: digestSchema,
  browserVersion: nonEmptyString,
  limits: profileLimitsSchema,
  networkPolicyId: nonEmptyString,
  available: z.boolean(),
  // Named, safe reasons only (no stderr, no host paths).
  unavailableReasons: z.array(nonEmptyString),
});

export const reaIdentitySchema = z.strictObject({
  packageVersion: nonEmptyString,
  catalogDigest: digestSchema,
  alignment: z.enum(["aligned", "mcp_server_restart_required", "unknown"]),
});

export const healthResponseSchema = z.strictObject({
  status: z.enum(["ready", "degraded"]),
  schemaVersion: z.int().nonnegative(),
  reaIdentity: reaIdentitySchema.nullable(),
  capabilities: z.array(nonEmptyString),
  effectiveProfiles: z.array(effectiveProfileSchema),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type EffectiveProfile = z.infer<typeof effectiveProfileSchema>;
