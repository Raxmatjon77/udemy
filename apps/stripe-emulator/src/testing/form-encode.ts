/** Encodes like stripe-node (`a[b][0]=v`, indexed arrays, undefined skipped) for raw HTTP tests. */
export function stripeForm(data: Readonly<Record<string, unknown>>): string {
  const pairs: string[] = [];
  const encode = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object') {
      pairs.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(value === null ? '' : String(value))}`,
      );
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => encode(`${key}[${index}]`, item));
      return;
    }
    for (const [child, item] of Object.entries(value)) encode(`${key}[${child}]`, item);
  };
  for (const [key, value] of Object.entries(data)) encode(key, value);
  return pairs.join('&');
}
