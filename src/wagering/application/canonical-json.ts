export type JsonValue = string | number | boolean | null
  | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };

// Emit sorted members directly: rebuilding an object would reorder integer keys.
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item: JsonValue) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as { readonly [key: string]: JsonValue | undefined };
    const members = Object.keys(object).sort().flatMap((key) => {
      const item = object[key];
      return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalizeJson(item)}`];
    });
    return `{${members.join(',')}}`;
  }
  throw new TypeError('Canonical JSON requires JSON values; undefined is only allowed in object properties');
}
