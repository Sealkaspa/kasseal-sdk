/**
 * `required(v, what)`: `v` when it is present, otherwise an error naming `what`.
 *
 * Used on money and state values where the surrounding checks guarantee a value the type cannot carry (a pool
 * state's layout-specific fields, a predicted cell's covenant id), in place of a non-null assertion: a refactor that
 * breaks the guard stops with a named error instead of encoding `undefined`.
 */
export function required<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`${what} is missing`);
  return v;
}
