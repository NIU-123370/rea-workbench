// JSON value semantics for DESIGN §4: no `any`, no lossy numeric sidecars.

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

// Numbers that survive a JSON round trip without losing precision are finite
// doubles; anything else must be carried as an explicit string plus its source.
export function isFiniteJsonNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
