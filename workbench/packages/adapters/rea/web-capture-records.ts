import type { CanonicalLimits } from "../../domain/canonical-json.ts";
import { asDigest, digestBytes } from "../../domain/canonical-json.ts";
import type { Coverage, Redaction } from "../../domain/evidence.ts";
import type { Id } from "../../domain/identity.ts";
import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";
import { ok } from "../../domain/result.ts";
import type { BodyValue, NameValue, RequestSide, ResponseSide } from "../../domain/vector.ts";
import type {
  ArtifactPort,
  EvidenceFactsFailure,
  EvidenceFactsPort,
  EvidenceRecordFacts,
  StorageWriterPort,
} from "../../application/ports.ts";
import type { VectorSource } from "../../domain/vector.ts";
import {
  harEntryReportedSchema,
  webNetworkCaptureResultSchema,
  type WebCaptureBinaryField,
  type WebCaptureRecord,
  type WebNetworkCaptureResult,
} from "../../contracts/rea-web-capture.ts";
import { reaEvidenceSchema, type ReaEvidence } from "../../contracts/rea-evidence.ts";

// Production `EvidenceFactsPort` for HTTP captures (DESIGN §7.1: the vector's
// request/response come out of persisted Evidence, never from the caller).
//
// It reads the envelope artifact exactly as REA produced it and answers one
// question: what did the producer record at this coordinate. Anything the
// producer did not keep is returned as null plus a reason, and a pointer this
// reader cannot resolve becomes a disclosed `missing`, never a guessed body.

export const WEB_CAPTURE_OPERATION = "inspect_web_network_capture";

type Failure = EvidenceFactsFailure;

function fail(code: Failure["code"], reason: string, message: string): Err<Failure> {
  return { ok: false, error: { code, reason, message } };
}

type Err<T> = { ok: false; error: T };

function mapRedactionReason(reason: string): Redaction["reason"] {
  return reason === "transport-credential" ? "transport-auth" : "explicit-sensitive";
}

// The pinned checkout documents record pointers as JSON pointers but does not
// fix whether the root is the record or the whole normalized document, so the
// match is done on the suffix the producer's own field path determines. A
// pointer that matches nothing yields a disclosed `missing` rather than a body
// this reader invented — the residual risk is under-reporting, not fabrication.
function pointerEnds(pointer: string, suffix: string): boolean {
  return pointer === suffix || pointer.endsWith(suffix);
}

function valueEntries(list: readonly { name: string; value: string }[]): NameValue[] {
  return list.map((entry) => ({ name: entry.name, value: entry.value }));
}

function bodyFromReported(
  reportedText: string | null | undefined,
  pointerSuffix: string,
  binaryFields: readonly WebCaptureBinaryField[],
  redactedPointers: readonly string[],
  absentReason: string,
): BodyValue {
  const binary = binaryFields.find((field) => pointerEnds(field.pointer, pointerSuffix));
  const redactedPointer = redactedPointers.find((pointer) => pointerEnds(pointer, pointerSuffix));
  if (binary !== undefined && binary.state === "redacted") {
    return { kind: "redacted", reason: `binary-field-redacted:${binary.pointer}` };
  }
  if (redactedPointer !== undefined) {
    return { kind: "redacted", reason: `producer-redaction:${redactedPointer}` };
  }
  if (binary !== undefined && binary.state === "retained") {
    return {
      kind: "bytes",
      base64: binary.content_base64,
      sha256: asDigest(binary.sha256),
    };
  }
  if (reportedText === null) {
    // mitmproxy keeps an explicit null body; collapsing it to "" would turn "the
    // producer could not decode it" into "the body was empty".
    return { kind: "missing", reason: "producer-reported-null" };
  }
  if (reportedText === undefined) {
    return { kind: "missing", reason: absentReason };
  }
  if (reportedText === "") return { kind: "empty" };
  return { kind: "text", text: reportedText, provenance: "producer-decoded" };
}

function coverageFrom(envelope: ReaEvidence, result: WebNetworkCaptureResult): Coverage {
  const relationship = envelope.relationship_coverage;
  if (relationship === null) {
    return { state: "unavailable", examined: null, total: null, reasons: ["relationship-coverage-absent"] };
  }
  // `diagnostics` is optional in the producer's union, so it is probed rather
  // than assumed.
  const diagnostics: string[] = "diagnostics" in relationship ? (relationship.diagnostics ?? []) : [];
  if (relationship.status === "complete") {
    return {
      state: "complete",
      examined: null,
      total: null,
      reasons: diagnostics,
    };
  }
  if (relationship.status === "partial") {
    const reasons = [...relationship.limitations, ...diagnostics];
    // A selection (`record_ordinals`) legitimately returns fewer records than
    // the container holds; the gap is stated, not hidden.
    if (result.records.length < result.total_records) {
      reasons.push(`records-selected:${String(result.records.length)}/${String(result.total_records)}`);
    }
    return {
      state: "partial",
      examined: result.records.length,
      total: result.total_records,
      reasons,
    };
  }
  return {
    state: "unknown",
    examined: null,
    total: null,
    reasons: [relationship.reason, ...diagnostics],
  };
}

function recordCoordinates(record: WebCaptureRecord, evidenceId: string): VectorSource {
  return {
    evidenceId,
    // REA states runtime attribution as `unknown` for file captures, so a HAR
    // never carries a fabricated capture id or browser transaction id (§7.1).
    captureId: null,
    recordOrdinal: record.ordinal,
    pointer: record.location.kind === "json-pointer" ? record.location.pointer : null,
    transactionId: null,
  };
}

function sideFromRecord(
  record: WebCaptureRecord,
  reported: { request?: unknown; response?: unknown },
  redactedPointers: string[],
): { request: RequestSide; response: ResponseSide } {
  const request = harEntryReportedSchema.safeParse(reported);
  const requestSide: RequestSide = {
    method: null,
    url: null,
    query: [],
    headers: [],
    body: { kind: "missing", reason: "reported-entry-unreadable" },
  };
  const responseSide: ResponseSide = {
    status: null,
    headers: [],
    body: { kind: "missing", reason: "reported-entry-unreadable" },
  };
  if (!request.success) {
    return { request: requestSide, response: responseSide };
  }
  const entry = request.data;
  const binary = record.binary_fields;
  const requestHeaders = valueEntries(entry.request.headers ?? []);
  const responseHeaders = valueEntries(entry.response.headers ?? []);
  const keepHeader = (baseSuffix: string, index: number) =>
    !redactedPointers.some((pointer) =>
      pointerEnds(pointer, `${baseSuffix}/headers/${String(index)}/value`),
    );
  return {
    request: {
      method: typeof entry.request.method === "string" && entry.request.method.length > 0
        ? entry.request.method
        : null,
      url: typeof entry.request.url === "string" && entry.request.url.length > 0
        ? entry.request.url
        : null,
      // Query stays an ordered multi-value list; folding it into an object would
      // silently merge repeated names (§7.1).
      query: (entry.request.queryString ?? []).map((pair) => ({ name: pair.name, value: pair.value })),
      headers: requestHeaders.filter((_, index) => keepHeader("/request", index)),
      body: bodyFromReported(
        entry.request.postData?.text,
        "/request/postData/text",
        binary,
        redactedPointers,
        "har-postdata-absent",
      ),
    },
    response: {
      status:
        typeof entry.response.status === "number" &&
        Number.isInteger(entry.response.status) &&
        entry.response.status >= 100 &&
        entry.response.status <= 599
          ? entry.response.status
          : null,
      headers: responseHeaders.filter((_, index) => keepHeader("/response", index)),
      body: bodyFromReported(
        entry.response.content?.text,
        "/response/content/text",
        binary,
        redactedPointers,
        entry.response.content === undefined ? "har-content-absent" : "har-content-text-absent",
      ),
    },
  };
}

export class WebCaptureEvidenceFacts implements EvidenceFactsPort {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly limits: CanonicalLimits;

  constructor(deps: { storage: StorageWriterPort; artifacts: ArtifactPort; limits: CanonicalLimits }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.limits = deps.limits;
  }

  private envelopeOf(bytes: Uint8Array): Result<ReaEvidence, Failure> {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as JsonValue;
    } catch {
      return fail("REA_CONTRACT_MISMATCH", "envelope-unparseable", "stored envelope is not JSON");
    }
    const checked = reaEvidenceSchema.safeParse(parsed);
    if (!checked.success) {
      return fail(
        "REA_CONTRACT_MISMATCH",
        "envelope-schema",
        `stored envelope violates the mirrored schema at ${checked.error.issues
          .map((issue) => issue.path.map(String).join("."))
          .slice(0, 3)
          .join(",")}`,
      );
    }
    if (checked.data.operation !== WEB_CAPTURE_OPERATION) {
      return fail(
        "UNSUPPORTED_FORMAT",
        "operation-not-web-capture",
        `operation ${checked.data.operation} has no HTTP record reader`,
      );
    }
    return ok(checked.data);
  }

  async readRecord(input: {
    projectId: Id;
    evidenceId: string;
    coordinate: VectorSource;
  }): Promise<Result<EvidenceRecordFacts, Failure>> {
    const looked = this.storage.transact((tx) => {
      const evidence = tx.getEvidence(input.projectId, input.evidenceId);
      if (evidence === null) return null;
      const artifact = tx.getArtifact(input.projectId, evidence.artifactId);
      const target = tx.getTarget(input.projectId, evidence.targetId);
      return { evidence, artifact, target };
    });
    if (!looked.ok) {
      return fail("REA_CONTRACT_MISMATCH", "storage-failure", looked.error.message);
    }
    if (looked.value === null) {
      return fail("NOT_FOUND", "evidence-unknown", "evidence is not persisted in this project");
    }
    const { evidence, artifact, target } = looked.value;
    if (artifact === null) {
      return fail("NOT_FOUND", "artifact-unknown", "evidence envelope artifact row is missing");
    }
    if (artifact.sha256 === null) {
      return fail(
        "REA_CONTRACT_MISMATCH",
        "artifact-digest-withheld",
        `artifact digest was withheld (${artifact.digestReason ?? "no reason recorded"})`,
      );
    }
    if (target === null || target.snapshotDigest === null) {
      return fail("INVALID_INPUT", "target-snapshot-missing", "target has no snapshot to bind");
    }

    const bytes = await this.artifacts.read(input.projectId, artifact.storageKey);
    if (!bytes.ok) {
      return fail("REA_CONTRACT_MISMATCH", "artifact-unreadable", bytes.error.message);
    }
    if (digestBytes(bytes.value) !== artifact.sha256) {
      return fail("REA_CONTRACT_MISMATCH", "artifact-digest-mismatch", "stored bytes changed");
    }
    const envelopeResult = this.envelopeOf(bytes.value);
    if (!envelopeResult.ok) return envelopeResult;
    const envelope = envelopeResult.value;
    if (envelope.evidence_id !== input.evidenceId) {
      return fail(
        "REA_CONTRACT_MISMATCH",
        "evidence-id-mismatch",
        "the stored envelope identifies a different evidence record",
      );
    }

    const normalized = webNetworkCaptureResultSchema.safeParse(envelope.normalized_result);
    if (!normalized.success) {
      return fail(
        "REA_CONTRACT_MISMATCH",
        "normalized-result-shape",
        `normalized_result violates the mirrored capture schema at ${normalized.error.issues
          .map((issue) => issue.path.map(String).join("."))
          .slice(0, 3)
          .join(",")}`,
      );
    }
    const result = normalized.data;

    if (input.coordinate.recordOrdinal === null) {
      return fail(
        "INVALID_INPUT",
        "record-ordinal-required",
        "HTTP capture records are addressed by ordinal",
      );
    }
    if (input.coordinate.transactionId !== null) {
      return fail(
        "INVALID_INPUT",
        "transaction-coordinate-unsupported",
        "file captures carry no browser transaction id; §7.1 forbids inventing one",
      );
    }
    const record = result.records.find((entry) => entry.ordinal === input.coordinate.recordOrdinal);
    if (record === undefined) {
      return fail(
        "NOT_FOUND",
        "record-ordinal-unavailable",
        `record ${String(input.coordinate.recordOrdinal)} is not retained in this envelope`,
      );
    }
    if (
      input.coordinate.pointer !== null &&
      (!pointerEnds(record.location.kind === "json-pointer" ? record.location.pointer : "", input.coordinate.pointer))
    ) {
      return fail(
        "INVALID_INPUT",
        "record-pointer-mismatch",
        "the record at that ordinal lives at a different pointer",
      );
    }

    const redactedPointers = [
      ...record.redactions.map((redaction) => redaction.pointer),
      ...record.binary_fields
        .filter((field) => field.state === "redacted")
        .map((field) => field.pointer),
    ];
    const sides = sideFromRecord(record, record.reported as { request?: unknown; response?: unknown }, redactedPointers);
    const declaredSensitive = envelope.parameters["sensitive_values"];
    const sensitiveDeclared = Array.isArray(declaredSensitive) && declaredSensitive.length > 0;

    return ok({
      evidenceId: envelope.evidence_id,
      projectId: input.projectId,
      targetId: evidence.targetId,
      snapshotDigest: target.snapshotDigest,
      operation: envelope.operation,
      authority: envelope.authority,
      confidence: envelope.confidence,
      source: recordCoordinates(record, envelope.evidence_id),
      request: sides.request,
      response: sides.response,
      coverage: coverageFrom(envelope, result),
      limitations: [...new Set([...envelope.limitations, ...record.limitations])],
      redactions: [
        ...record.redactions.map((redaction) => ({
          fieldPointer: redaction.pointer,
          reason: mapRedactionReason(redaction.reason),
          representation: "omitted" as const,
        })),
        ...record.binary_fields
          .filter((field) => field.state === "redacted")
          .map((field) => ({
            fieldPointer: field.pointer,
            reason: "explicit-sensitive" as const,
            representation: "omitted" as const,
          })),
      ],
      sensitiveDeclared,
    });
  }
}
