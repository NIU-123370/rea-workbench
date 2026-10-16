// Expected internal failures travel as a tagged Result, and only the HTTP
// adapter maps them onto status codes (DESIGN §4).
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function mapResult<T, U, E>(input: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return input.ok ? ok(fn(input.value)) : input;
}

export function mapErr<T, E, F>(
  input: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return input.ok ? input : err(fn(input.error));
}

export function allResults<T, E>(inputs: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const input of inputs) {
    if (!input.ok) return input;
    values.push(input.value);
  }
  return ok(values);
}
