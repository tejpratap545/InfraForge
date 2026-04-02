import { TenantContext } from "../types";

interface CounterState {
  windowStart: number;
  count: number;
}

export class RateLimiterService {
  private readonly counters = new Map<string, CounterState>();

  assertWithinLimit(tenant: TenantContext, maxPerMinute: number): void {
    const key = `${tenant.tenantId}:${tenant.userId}`;
    const now = Date.now();
    const current = this.counters.get(key);

    if (!current || now - current.windowStart > 60_000) {
      this.counters.set(key, { windowStart: now, count: 1 });
      return;
    }

    if (current.count >= maxPerMinute) {
      throw new Error(
        `Rate limit exceeded for tenant '${tenant.tenantId}'. Try again in a minute.`,
      );
    }

    current.count += 1;
    this.counters.set(key, current);
  }
}
