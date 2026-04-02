import { z } from "zod";
import { BedrockService } from "../services/bedrockService";
import { AskPlan, AskMetricsContext, AwsInventorySnapshot } from "../types";
import { parseJsonPayload } from "../utils/llm";
import { RESOURCE_CATALOG, buildResourceTypeList } from "../services/resourceTypeRegistry";

// ─── Planner schema ───────────────────────────────────────────────────────────

const MetricsContextSchema = z.object({
  resourceType: z.string(),
  resourceId: z.string().nullish().transform((v) => v ?? undefined),
  metrics: z.array(z.string()).default([]),
  periodHours: z.number().default(1),
});

const K8sQuerySchema = z.object({
  resources: z.array(z.string()).default(["pods"]),
  namespace: z.string().nullish().transform((v) => v ?? undefined),
  clusterName: z.string().nullish().transform((v) => v ?? undefined),
});

const AskPlanSchema = z.object({
  targets: z.array(z.string()).default([]),
  questionType: z.enum(["count", "list", "summary", "metrics", "k8s", "unknown"]).default("unknown"),
  region: z.string().nullish().transform((v) => (v?.trim() || undefined)),
  metricsQuery: MetricsContextSchema.nullish().transform((v) => v ?? undefined),
  k8sQuery: K8sQuerySchema.nullish().transform((v) => v ?? undefined),
  unsupportedReason: z.string().nullish().transform((v) => v ?? undefined),
});

// ─── CloudWatch metrics catalog ───────────────────────────────────────────────

const METRICS_CATALOG = `
CLOUDWATCH METRICS (use for performance/health questions):
Metrics are available for: ec2, eks, ecs, rds, lambda, alb, elasticache
Common metric names by resource:
- ec2:         CPUUtilization, NetworkIn, NetworkOut, DiskReadOps, StatusCheckFailed
- lambda:      Invocations, Errors, Throttles, Duration, ConcurrentExecutions
- rds:         CPUUtilization, DatabaseConnections, FreeStorageSpace, ReadIOPS, WriteIOPS
- ecs:         CPUUtilization, MemoryUtilization
- alb:         RequestCount, TargetResponseTime, HTTPCode_Target_5XX_Count, ActiveConnectionCount
- eks:         pod_cpu_utilization, pod_memory_utilization (ContainerInsights)
- elasticache: CPUUtilization, CurrConnections, CacheHits, CacheMisses, Evictions
`;

export class AskAgent {
  constructor(private readonly bedrock: BedrockService) {}

  async plan(question: string): Promise<AskPlan> {
    const prompt = [
      "You are an AWS inventory and metrics query planner.",
      "Given a natural-language question about AWS, produce a JSON execution plan.",
      "",
      RESOURCE_CATALOG,
      "",
      METRICS_CATALOG,
      "",
      "KUBERNETES RESOURCES (use k8s questionType for in-cluster questions):",
      "  - pods, namespaces, deployments, services, statefulsets, daemonsets,",
      "    nodes, ingresses, configmaps, jobs, cronjobs, events, replicasets, pvcs",
      "  - Use questionType='k8s' and populate k8sQuery when the question is about",
      "    resources INSIDE a cluster (pods, namespaces, deployments, etc.)",
      "  - Use questionType='list' + targets=['eks'] when asking about the EKS clusters themselves.",
      "",
      "RULES:",
      "1. For list/count/existence questions about AWS resources → targets = CF types, questionType = 'count'|'list'|'summary'.",
      "2. For in-cluster k8s questions (pods, namespaces, deployments, services) → questionType='k8s', populate k8sQuery.",
      "3. For performance/health/metrics questions (CPU, memory, errors, latency) → questionType='metrics', populate metricsQuery.",
      "4. For broad questions ('give me everything') → select all relevant services, questionType='summary'.",
      "5. If a specific AWS region is mentioned (e.g. ap-south-1, us-west-2) → extract it into 'region'.",
      "6. Prefer answering over refusing — almost all AWS/k8s questions can be answered.",
      "",
      "OUTPUT: Return ONLY valid JSON. No markdown fences. No explanation.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        targets: ["eks"],
        questionType: "count|list|summary|metrics|k8s|unknown",
        region: "ap-south-1 (optional)",
        metricsQuery: {
          resourceType: "ec2|eks|lambda|rds|ecs|alb|elasticache",
          resourceId: "optional",
          metrics: ["CPUUtilization"],
          periodHours: 1,
        },
        k8sQuery: {
          resources: ["pods", "namespaces"],
          namespace: "optional — omit for all-namespaces",
          clusterName: "optional EKS cluster name",
        },
        unsupportedReason: "optional",
      }),
      "",
      `USER QUESTION: ${question}`,
    ].join("\n");

    const response = await this.bedrock.complete(prompt);
    const normalized = AskPlanSchema.parse(parseJsonPayload(response, "Ask planner"));

    // If nothing was selected but it's not unknown/metrics, fall back to broad summary
    if (normalized.targets.length === 0 && normalized.questionType !== "metrics" && normalized.questionType !== "unknown") {
      const broadTargets = buildResourceTypeList([
        "ec2", "eks", "ecs", "s3", "rds", "lambda", "dynamodb",
        "sqs", "sns", "vpc", "iam", "alb", "cloudformation",
      ]);
      return { targets: broadTargets, questionType: "summary" };
    }
    // Resolve aliases → CloudFormation type strings
    return { ...normalized, targets: buildResourceTypeList(normalized.targets) };
  }

  async answer(
    question: string,
    snapshot: AwsInventorySnapshot,
    metricsSnapshot?: string,
    k8sSnapshot?: string,
  ): Promise<string> {
    const inventorySummary = this.formatSnapshotForLLM(snapshot);

    const sections = [
      "You are an AWS infrastructure assistant.",
      "Answer the user's question using ONLY the live AWS data provided below.",
      "Never invent resources, counts, metrics, costs, or states not in the data.",
      "",
      "ANSWER STYLE:",
      "- First sentence: the direct answer.",
      "- Use ## for sections, **name** for resource names, - for bullet lists.",
      "- Include counts, versions, status, and metric values where available.",
      "- If a service errored, mention it briefly (e.g. 'ECS data unavailable: access denied').",
      "",
      `USER QUESTION: ${question}`,
      "",
      `LIVE AWS INVENTORY  (account: ${snapshot.accountId ?? "?"}, region: ${snapshot.region}, as of ${snapshot.generatedAt}):`,
      "",
      inventorySummary,
    ];

    if (metricsSnapshot) {
      sections.push("", "LIVE CLOUDWATCH METRICS:", "", metricsSnapshot);
    }

    if (k8sSnapshot) {
      sections.push("", "LIVE KUBERNETES DATA:", "", k8sSnapshot);
    }

    return this.bedrock.complete(sections.join("\n"), { maxTokens: 2000 });
  }

  // ─── Snapshot formatter ───────────────────────────────────────────────────

  formatSnapshotForLLM(snapshot: AwsInventorySnapshot): string {
    const lines: string[] = [];

    for (const [service, result] of Object.entries(snapshot.services)) {
      if (!result) continue;
      if (result.error) {
        lines.push(`${service.toUpperCase()} — ERROR: ${result.error}`);
        lines.push("");
        continue;
      }
      lines.push(`${service.toUpperCase()} (${result.count} total):`);
      if (result.items.length === 0) {
        lines.push("  (none found)");
      } else {
        for (const item of result.items as Record<string, unknown>[]) {
          lines.push("  - " + this.formatItem(service, item));
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  private formatItem(service: string, item: Record<string, unknown>): string {
    switch (service) {
      case "ec2":
        return `${item["instanceId"]} (${item["instanceType"]}, ${item["state"]}, ${item["availabilityZone"] ?? "?"})` +
          (item["name"] ? ` [${item["name"]}]` : "");
      case "eks":
        return `${item["name"]}  status=${item["status"]}  k8s=${item["kubernetesVersion"]}  nodegroups=${item["nodegroupCount"]}`;
      case "ecs":
        return `${item["clusterName"]}  status=${item["status"]}  activeServices=${item["activeServicesCount"]}  runningTasks=${item["runningTasksCount"]}`;
      case "ecr":
        return `${item["repositoryName"]}  images=${item["imageCount"] ?? "?"}  pushed=${item["lastPushed"] ?? "unknown"}`;
      case "s3":
        return `${item["name"]}` + (item["createdAt"] ? `  created=${(item["createdAt"] as string).slice(0, 10)}` : "");
      case "rds":
        return `${item["identifier"]}  ${item["engine"]} ${item["engineVersion"]}  ${item["instanceClass"]}  status=${item["status"]}` +
          (item["multiAz"] ? "  multi-az" : "");
      case "elasticache":
        return `${item["clusterId"]}  engine=${item["engine"]}  nodeType=${item["cacheNodeType"]}  status=${item["cacheClusterStatus"]}`;
      case "lambda":
        return `${item["name"]}  runtime=${item["runtime"]}  memory=${item["memorySizeMb"]}MB  timeout=${item["timeoutSec"]}s`;
      case "dynamodb":
        return `${item["name"]}`;
      case "sqs":
        return `${item["name"]}`;
      case "sns":
        return `${item["name"]}`;
      case "vpc":
        return `${item["vpcId"]}  cidr=${item["cidrBlock"]}  state=${item["state"]}` +
          (item["isDefault"] ? "  [default]" : "") +
          (item["name"] ? `  [${item["name"]}]` : "");
      case "iam":
        return `${item["roleName"]}`;
      case "cloudformation":
        return `${item["stackName"]}  status=${item["stackStatus"]}  resources=${item["resourceCount"] ?? "?"}` +
          (item["description"] ? `  — ${item["description"]}` : "");
      case "route53":
        return `${item["name"]}  records=${item["resourceRecordSetCount"] ?? "?"}  private=${item["privateZone"] ?? false}`;
      case "alb":
        return `${item["loadBalancerName"]}  scheme=${item["scheme"]}  state=${item["state"]}  dns=${item["dnsName"]}`;
      default:
        return JSON.stringify(item);
    }
  }

  /** Human-readable description for spinner. */
  describeMetricsQuery(ctx: AskMetricsContext): string {
    return `${ctx.resourceType.toUpperCase()} — ${ctx.metrics.join(", ")} — last ${ctx.periodHours}h`;
  }

  describeK8sQuery(q: import("../types").AskK8sQuery): string {
    return `${q.resources.join(", ")}${q.clusterName ? ` in ${q.clusterName}` : ""}`;
  }
}
