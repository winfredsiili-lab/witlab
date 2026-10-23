const cache = new Map<string, { value: unknown; expires: number }>();
const TTL = 60 * 60 * 1000;

export function cacheKey(userId: string, sourceId: string, scopeHash: string): string {
  return `${userId}:${sourceId}:${scopeHash}`;
}

export function getExtraction(key: string): unknown | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) { cache.delete(key); return undefined; }
  return e.value;
}

export function setExtraction(key: string, value: unknown): void {
  cache.set(key, { value, expires: Date.now() + TTL });
}
