function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }

  return value;
}

export function toCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function parseCanonicalJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
