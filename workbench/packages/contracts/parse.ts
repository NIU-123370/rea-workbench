import type { Result } from "../domain/result.ts";
import type { ZodType } from "zod";

// Every wire input starts as `unknown` and is parsed by a named strict schema
// that rejects extra fields (DESIGN §4, §8).
export type ParseFailure = {
  code: "INVALID_INPUT";
  message: string;
  issues: { path: string; reason: string; message: string }[];
};

export function parseStrict<T>(schema: ZodType<T>, input: unknown): Result<T, ParseFailure> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "<root>",
    reason: issue.code === "unrecognized_keys" ? "unrecognized-key" : issue.code,
    message: issue.message,
  }));
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "input does not satisfy the named schema",
      issues,
    },
  };
}
