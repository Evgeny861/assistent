// Simple fixed-window in-memory rate limiter.
// Process-local (single instance by design); resets on restart — acceptable for an MVP.
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private windowMs: number, private max: number) {}
  check(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    b.count += 1;
    return b.count <= this.max;
  }
  // Periodic sweep so the map does not grow unbounded.
  sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
