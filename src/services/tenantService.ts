import { TenantContext, AwsCredentials } from "../types";

export class TenantService {
  buildContext(input: {
    tenantId: string;
    userId: string;
    subscriptionTier: "free" | "pro" | "enterprise";
    awsRegion: string;
    awsCredentials?: AwsCredentials;
  }): TenantContext {
    if (!input.tenantId || !input.userId) {
      throw new Error("tenantId and userId are required for multi-tenant operations.");
    }
    return {
      tenantId: input.tenantId,
      userId: input.userId,
      subscriptionTier: input.subscriptionTier,
      awsRegion: input.awsRegion,
      ...(input.awsCredentials && { awsCredentials: input.awsCredentials }),
    };
  }
}
