import { invalidRequest } from './stripe-error';

/**
 * Stripe's form encoding: `a[b][0][c]=v` (stripe-node writes array indices; `a[]=v` appends).
 * Everything decodes to nested null-prototype objects with string leaves; arrays stay objects
 * keyed "0".."n-1" until a validator asks for one (`asArray`), because a metadata key may
 * legitimately be "0".
 */
export type FormValue = string | FormObject;
export interface FormObject {
  [key: string]: FormValue;
}

const MAX_DEPTH = 8;
const MAX_PAIRS = 2_000;

function newObject(): FormObject {
  return Object.create(null) as FormObject;
}

export function isFormObject(value: FormValue | undefined): value is FormObject {
  return typeof value === 'object' && value !== null;
}

/** `line_items[0][price_data][currency]` → ['line_items', '0', 'price_data', 'currency']. */
export function parseKey(key: string): string[] {
  const open = key.indexOf('[');
  if (open === -1) {
    if (key === '') throw invalidRequest('Invalid request: empty parameter name.');
    return [key];
  }
  const head = key.slice(0, open);
  if (head === '') throw invalidRequest(`Invalid parameter name: ${key}`);
  const segments = [head];
  let rest = key.slice(open);
  while (rest !== '') {
    const match = /^\[([^[\]]*)\]/.exec(rest);
    if (match === null) throw invalidRequest(`Invalid parameter name: ${key}`);
    segments.push(match[1] ?? '');
    rest = rest.slice(match[0].length);
  }
  if (segments.length > MAX_DEPTH) throw invalidRequest(`Parameter nested too deeply: ${key}`);
  return segments;
}

/** Decodes an `application/x-www-form-urlencoded` body or query string into a tree. */
export function parseForm(encoded: string): FormObject {
  const root = newObject();
  const params = new URLSearchParams(encoded);
  let pairs = 0;
  for (const [key, value] of params) {
    pairs += 1;
    if (pairs > MAX_PAIRS) throw invalidRequest('Too many parameters.');
    const segments = parseKey(key);
    let node = root;
    for (let index = 0; index < segments.length; index += 1) {
      let segment = segments[index] ?? '';
      const last = index === segments.length - 1;
      if (segment === '') {
        if (index === 0) throw invalidRequest(`Invalid parameter name: ${key}`);
        segment = String(Object.keys(node).length); // `a[]=` appends
      }
      const existing = node[segment];
      if (last) {
        if (existing !== undefined) {
          throw invalidRequest(`Received the parameter ${key} more than once.`, undefined, key);
        }
        node[segment] = value;
      } else if (existing === undefined) {
        const child = newObject();
        node[segment] = child;
        node = child;
      } else if (isFormObject(existing)) {
        node = existing;
      } else {
        throw invalidRequest(`Invalid parameter: ${key} mixes a value and a hash.`, undefined, key);
      }
    }
  }
  return root;
}

/** Deterministic serialization (sorted keys) for idempotency fingerprints. */
export function canonicalForm(value: FormValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalForm(value[key] ?? '')}`).join(',')}}`;
}
