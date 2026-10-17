import { createHash } from "node:crypto";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import type { ArtifactRow, BlueprintRow } from "../../packages/application/ports.ts";
import type { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import type { BlueprintPayload } from "../../packages/domain/blueprint.ts";

// A frozen blueprint handoff, seeded the way the real handoff leaves it: the payload
// in the artifact store, the index row pointing at it, and the plan the blueprint was
// built from. Two suites need this — the Builder service itself and the worker command
// that reaches it — and a hand-written copy in each would drift from the first schema
// change (DESIGN §7.3, §10).

export function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function blueprintPayload(blueprintId: Id, digest: Digest, withPost = false): BlueprintPayload {
  return {
    schemaVersion: 1,
    blueprintId,
    blueprintDigest: digest,
    contractRevisions: [
      {
        contractKey: "cart-read",
        revision: 1,
        digest: asDigest("1".repeat(64)),
        behaviorSpec: "reads the cart with the requested include set",
        inputSchema: { type: "object", properties: { include: { type: "string" } }, required: ["include"] },
        outputSchema: { type: "object", properties: { items: { type: "array" } } },
        httpOperations: [
          {
            operationId: "getCart",
            method: "GET",
            path: "/api/cart/42",
            requestMediaType: "application/json",
            responses: [{ status: 200, mediaType: "application/json", schema: { type: "object" } }],
          },
          // A body-carrying sibling, off by default: without one, every generated candidate has only
          // GET routes and the `content-type`/body half of the adapter is a branch nothing executes.
          ...(withPost ? [{
            operationId: "addCartItem",
            method: "POST",
            path: "/api/cart/items",
            requestMediaType: "application/json",
            responses: [{ status: 201, mediaType: "application/json", schema: { type: "object" } }],
          }] : []),
        ],
        errorCases: ["401 unauthenticated"],
        limitations: ["no retry semantics observed"],
        unknowns: ["pagination shape"],
      },
    ],
    publicVectors: [],
    generation: { language: "typescript", outputKind: "http-sdk", openapiVersion: "3.1.1" },
    verificationScope: ["getCart"],
  };
}

export type SeededBlueprint = { blueprintId: Id; digest: Digest; artifactId: Id; planId: Id; createdAt: Instant };

export async function seedBlueprintForGeneration(deps: {
  writer: SqliteStorageWriter;
  store: ArtifactStore;
  projectId: Id;
  targetId: Id;
  name: string;
  // When true the index row carries a digest the payload does not claim, which is the
  // disagreement the Builder has to refuse rather than generate from.
  mismatchRowDigest?: boolean;
  // Adds a POST operation to the reviewed contract, so a candidate can be exercised on the branch
  // that carries a request body. Off by default: the other consumers of this fixture read the
  // one-operation shape they were written against.
  withPost?: boolean;
}): Promise<SeededBlueprint> {
  const { writer, store, projectId, targetId, name, withPost = false } = deps;
  const blueprintId = newId();
  const digest = asDigest(hex(`blueprint-${name}`));
  const rowDigest = deps.mismatchRowDigest === true ? asDigest(hex(`other-${name}`)) : digest;
  const payload = blueprintPayload(blueprintId, rowDigest, withPost);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const published = await store.publish(projectId, "blueprint", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const artifactId = newId();
  const manifestArtifactId = newId();
  // Bodies are unique per seed: the artifact store dedupes inside
  // (project, class, digest), so a shared constant body would collide instead of
  // seeding a second blueprint.
  const manifest = await store.publish(
    projectId,
    "inspector",
    new TextEncoder().encode(JSON.stringify({ manifest: true, for: name })),
  );
  if (!manifest.ok) throw new Error(JSON.stringify(manifest.error));
  const createdAt = nowInstant();
  const planId = newId();
  const planContent = {
    id: planId,
    targetId,
    snapshotDigest: asDigest(hex(`snapshot-${name}`)),
    contractRevisionIds: [newId()],
    graphRevision: 1,
    inventoryRevision: 1,
    inventoryDigest: asDigest(hex(`inventory-${name}`)),
    selectedVectorIds: [],
    excludedVectors: [],
  };

  const row: BlueprintRow = {
    id: blueprintId,
    projectId,
    targetId,
    graphRevision: 1,
    snapshotDigest: asDigest(hex(`snapshot-${name}`)),
    verificationPlanId: planId,
    artifactId,
    digest,
    sourceManifestArtifactId: manifestArtifactId,
    createdAt,
  };
  const inserted = writer.transact((tx) => {
    tx.insertPlan({
      id: planId,
      projectId,
      targetId,
      snapshotDigest: planContent.snapshotDigest,
      graphRevision: 1,
      inventoryRevision: 1,
      inventoryDigest: planContent.inventoryDigest,
      payloadJson: planContent as unknown as JsonValue,
      digest: asDigest(hex(`plan-${name}`)),
      reviewStatus: "approved",
      reviewRecordJson: null,
      createdAt,
    });
    const artifact: ArtifactRow = {
      id: artifactId,
      projectId,
      jobId: null,
      class: "blueprint",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt,
    };
    tx.insertArtifact(artifact);
    tx.insertArtifact({
      id: manifestArtifactId,
      projectId,
      jobId: null,
      class: "inspector",
      sha256: manifest.value.sha256,
      digestReason: null,
      byteLength: manifest.value.byteLength,
      storageKey: manifest.value.storageKey,
      mediaType: "application/json",
      createdAt,
    });
    tx.insertBlueprint(row);
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return { blueprintId, digest, artifactId, planId, createdAt };
}
