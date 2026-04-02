/**
 * AWS Cloud Control API — single generic client that covers 300+ resource types.
 * No per-service code: just pass a CloudFormation type string like "AWS::EKS::Cluster".
 */
import {
  CloudControlClient,
  ListResourcesCommand,
  ProgressEvent,
} from "@aws-sdk/client-cloudcontrol";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { AwsInventoryServiceResult, AwsInventorySnapshot } from "../types";

export { buildResourceTypeList } from "./resourceTypeRegistry";

export class AwsInventoryService {
  /**
   * Collect any set of AWS resource types using Cloud Control API.
   * @param typeNames  CloudFormation type strings, e.g. ["AWS::EKS::Cluster", "AWS::S3::Bucket"]
   * @param region     AWS region to query
   */
  async collect(typeNames: string[], region: string): Promise<AwsInventorySnapshot> {
    const identity = await this.getCallerIdentity(region);

    const entries = await Promise.all(
      [...new Set(typeNames)].map(async (typeName) => [typeName, await this.listType(typeName, region)] as const),
    );

    return {
      accountId: identity?.Account,
      accountArn: identity?.Arn,
      region,
      generatedAt: new Date().toISOString(),
      services: Object.fromEntries(entries),
    };
  }

  private async listType(typeName: string, region: string): Promise<AwsInventoryServiceResult> {
    const client = new CloudControlClient({ region });
    const items: object[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const res = await client.send(
          new ListResourcesCommand({ TypeName: typeName, NextToken: nextToken }),
        );
        nextToken = res.NextToken;
        for (const desc of res.ResourceDescriptions ?? []) {
          items.push(this.parseProperties(desc));
        }
      } while (nextToken);

      return { count: items.length, items };
    } catch (error: unknown) {
      return { count: 0, items: [], error: this.toUserFriendlyError(typeName, error) };
    }
  }

  private parseProperties(desc: { Identifier?: string; Properties?: string }): object {
    try {
      const props = desc.Properties ? (JSON.parse(desc.Properties) as Record<string, unknown>) : {};
      // Always surface the identifier (primary key) at the top level
      if (desc.Identifier) props["_id"] = desc.Identifier;
      return props;
    } catch {
      return { _id: desc.Identifier ?? "unknown" };
    }
  }

  private async getCallerIdentity(region: string): Promise<{ Account?: string; Arn?: string } | undefined> {
    try {
      const sts = new STSClient({ region });
      const res = await sts.send(new GetCallerIdentityCommand({}));
      return { Account: res.Account, Arn: res.Arn };
    } catch {
      return undefined;
    }
  }

  private toUserFriendlyError(typeName: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const n = raw.toLowerCase();
    if (n.includes("unsupported") || n.includes("resource type") || n.includes("is not supported")) {
      return `Resource type ${typeName} is not supported in this region via Cloud Control API.`;
    }
    if (n.includes("accessdenied") || n.includes("is not authorized")) {
      return `Access denied for ${typeName}. Check IAM permissions.`;
    }
    if (n.includes("credentialsprovider") || n.includes("no credentials")) {
      return "AWS credentials are not configured.";
    }
    return raw;
  }
}

// Re-export so workflow code can use the progress type if needed
export type { ProgressEvent };
