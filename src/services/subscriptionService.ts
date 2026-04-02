import { TenantContext } from "../types";

const LIMITS = {
  free: { commandsPerMinute: 15, allowApply: false },
  pro: { commandsPerMinute: 60, allowApply: true },
  enterprise: { commandsPerMinute: 240, allowApply: true },
} as const;

export class SubscriptionService {
  getLimits(tenant: TenantContext): { commandsPerMinute: number; allowApply: boolean } {
    return LIMITS[tenant.subscriptionTier];
  }

  assertCanApply(tenant: TenantContext): void {
    const limits = this.getLimits(tenant);
    if (!limits.allowApply) {
      throw new Error(
        `Subscription tier '${tenant.subscriptionTier}' does not allow apply. Upgrade required.`,
      );
    }
  }
}
