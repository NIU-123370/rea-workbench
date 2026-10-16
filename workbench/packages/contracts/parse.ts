import type { Result } from "../domain/result.ts";
import type { ZodType } from "zod";

// Every wire input starts as `unknown` and is parsed by a named strict schema
// that rejects extra fields (DESIGN §4, §8).
export type ParseFailure = {
  code: "INVALID_INPUT";
  message: string;
  // `keys` appears only on a strict-object refusal, and names the fields the caller sent that
  // the schema does not have. A caller has to be able to learn what to remove: the name is the
  // whole answer, and it is not the value that came with it, which stays unechoed (§12.1).
  issues: { path: string; reason: string; message: string; keys?: string[] }[];
};

export function parseStrict<T>(schema: ZodType<T>, input: unknown): Result<T, ParseFailure> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issues = parsed.error.issues.map((issue) => {
    const keys = "keys" in issue ? (issue.keys as string[] | undefined) : undefined;
    return {
      path: issue.path.map(String).join(".") || "<root>",
      reason: issue.code === "unrecognized_keys" ? "unrecognized-key" : issue.code,
      message: issue.message,
      ...(keys === undefined || keys.length === 0 ? {} : { keys }),
    };
  });
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "input does not satisfy the named schema",
      issues,
    },
  };
}
