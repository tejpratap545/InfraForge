/**
 * diagnoseTools.ts
 *
 * Comprehensive SRE diagnostic toolkit — the LLM generates all parameters dynamically.
 *
 * Core tools:
 *   run_command   — any read-only shell command (kubectl, helm, dig, nc …)
 *   aws_query     — Cloud Control ListResources for any AWS::* type
 *   aws_get       — Cloud Control GetResource for a specific resource
 *   ec2_exec      — run a command ON an EC2 instance via AWS SSM SDK (no SSH/CLI needed)
 *
 * AWS observability:
 *   cw_metrics    — CloudWatch metric statistics (CPU, latency, errors, connections …)
 *   cw_logs       — CloudWatch Logs search
 *   pi_top_sql    — Performance Insights top SQL by DB load
 *
 * AWS infrastructure:
 *   ecs_describe  — ECS services, tasks, deployments, container status
 *   elb_health    — ALB/NLB target group health checks
 *   cloudtrail    — recent API events / deployments / config changes
 *   asg_activity  — Auto Scaling group scaling events
 *   route53_check — DNS record lookup via Route 53
 *
 * K8s tools:
 *   k8s_pods      — structured pod status (restarts, OOM, CrashLoop detection)
 *   k8s_events    — recent cluster events with severity filtering
 *   k8s_logs      — pod/container log search with filtering
 *
 * MCP:
 *   mcp_tool      — route to any connected AWS MCP server tool
 */

import { exec } from "node:child_process";
import {
  CloudControlClient,
  ListResourcesCommand,
  ListResourcesCommandOutput,
  GetResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  Statistic,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  PIClient,
  DescribeDimensionKeysCommand,
} from "@aws-sdk/client-pi";
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  ListClustersCommand,
} from "@aws-sdk/client-ecs";
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetHealthCommand,
  DescribeTargetGroupsCommand,
  DescribeLoadBalancersCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  CloudTrailClient,
  LookupEventsCommand,
  type LookupAttribute,
} from "@aws-sdk/client-cloudtrail";
import {
  AutoScalingClient,
  DescribeScalingActivitiesCommand,
  DescribeAutoScalingGroupsCommand,
} from "@aws-sdk/client-auto-scaling";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import {
  Route53Client,
  ListResourceRecordSetsCommand,
  ListHostedZonesCommand,
} from "@aws-sdk/client-route-53";
import type { AwsCredentials } from "../types";
import type { AwsMcpService, AwsMcpTool } from "./awsMcpService";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolContext {
  awsRegion: string;
  k8sContext?: string;
  /** Explicit AWS credentials. Falls back to SDK default chain if omitted. */
  awsCredentials?: AwsCredentials;
  /** Connected AWS MCP service instance. Undefined if MCP is not configured. */
  mcpService?: AwsMcpService;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build AWS SDK client config from context. */
function awsConfig(ctx: ToolContext, regionOverride?: string) {
  return {
    region: regionOverride?.trim() || ctx.awsRegion,
    ...(ctx.awsCredentials && { credentials: ctx.awsCredentials }),
  };
}

// ─── Safety blocklist for run_command ────────────────────────────────────────
// Only blocks destructive operations. All read/diagnostic commands pass.

const BLOCKED: RegExp[] = [
  /\brm\s+-[rf]/i,
  /\bformat\b/i,
  /\bfdisk\b/i,
  // AWS CLI is allowed via aws_cli() tool — not here in run_command
  /kubectl\s+delete\b/i,
  /kubectl\s+apply\b/i,
  /kubectl\s+patch\b/i,
  /kubectl\s+edit\b/i,
  /kubectl\s+scale\b/i,
  /\|\s*(sh|bash|zsh)\b/,
  /curl\s+.*\|\s*(sh|bash)/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(sd|nvme)/i,
];

function isSafe(cmd: string): boolean {
  return !BLOCKED.some((r) => r.test(cmd));
}

// ─── Shell runner ─────────────────────────────────────────────────────────────

function shell(cmd: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (_err, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve(combined.slice(0, 8_000) || "(no output)");
    });
  });
}

// ─── Tool 1: run_command ──────────────────────────────────────────────────────

export async function run_command(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const cmd = params["command"]?.trim();
  if (!cmd) return "ERROR: command param is required";
  if (!isSafe(cmd)) {
    if (/^\s*aws\s+/i.test(cmd)) {
      return `Use the aws_cli tool for AWS CLI commands — it injects credentials and enforces read-only safety.`;
    }
    return `BLOCKED: command matches safety blocklist — "${cmd}"`;
  }

  // Inject k8s context into kubectl and helm commands
  const needsCtx = ctx.k8sContext && !cmd.includes("--context") && !cmd.includes("--kube-context");
  const finalCmd = needsCtx && /^(kubectl|helm)\s/.test(cmd)
    ? cmd.startsWith("kubectl")
      ? `${cmd} --context ${ctx.k8sContext}`
      : `${cmd} --kube-context ${ctx.k8sContext}`
    : cmd;

  return shell(finalCmd);
}

// ─── Tool 2: aws_query ────────────────────────────────────────────────────────

export async function aws_query(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const typeName = params["type"]?.trim();
  if (!typeName) return "ERROR: type param is required (e.g. AWS::EC2::SecurityGroup)";

  const r          = params["region"]?.trim() || ctx.awsRegion;
  const maxResults  = Math.min(parseInt(params["max_results"] ?? "20", 10), 50);
  const rawFilter = params["filter"];
  let filter: string | undefined;
  if (rawFilter == null || rawFilter === "") {
    filter = undefined;
  } else if (typeof rawFilter === "object") {
    filter = JSON.stringify(rawFilter) || undefined;
  } else {
    const s = String(rawFilter).trim();
    if (!s) {
      filter = undefined;
    } else if (s.startsWith("{")) {
      try { JSON.parse(s); filter = s; } catch { filter = undefined; }
    } else if (s.includes("=")) {
      const obj: Record<string, string> = {};
      s.split(",").forEach((kv) => {
        const eq = kv.indexOf("=");
        if (eq > 0) obj[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      });
      filter = Object.keys(obj).length ? JSON.stringify(obj) : undefined;
    } else {
      filter = undefined;
    }
  }

  const nameFilter = params["name_filter"]?.trim().toLowerCase() || undefined;
  const nextTokenIn = params["next_token"]?.trim() || undefined;

  const client = new CloudControlClient(awsConfig(ctx, r));

  function formatItem(item: { Identifier?: string; Properties?: string }): string {
    const id = item.Identifier ?? "?";
    let props = "";
    try {
      props = item.Properties ? JSON.stringify(JSON.parse(item.Properties)) : "";
    } catch {
      props = item.Properties ?? "";
    }
    return `${id}  ${props.slice(0, 600)}`;
  }

  try {
    if (nameFilter) {
      const matched: string[] = [];
      let token: string | undefined;
      let pages = 0;
      const pageSize = 50;

      while (pages < 10) {
        const res: ListResourcesCommandOutput = await client.send(
          new ListResourcesCommand({ TypeName: typeName, MaxResults: pageSize, ResourceModel: filter, NextToken: token }),
        );
        pages++;

        for (const item of res.ResourceDescriptions ?? []) {
          const id    = item.Identifier ?? "";
          const props = item.Properties ?? "";
          if (id.toLowerCase().includes(nameFilter) || props.toLowerCase().includes(nameFilter)) {
            matched.push(formatItem(item));
          }
        }

        token = res.NextToken;
        if (!token) break;
        if (matched.length >= maxResults) break;
      }

      if (matched.length === 0) {
        return `No ${typeName} matched name_filter="${nameFilter}" after scanning ${pages} page(s) in ${r}`;
      }
      return `${typeName} matching "${nameFilter}" in ${r} (${matched.length} found, scanned ${pages} page(s)):\n` + matched.join("\n");
    }

    const res = await client.send(
      new ListResourcesCommand({ TypeName: typeName, MaxResults: maxResults, ResourceModel: filter, NextToken: nextTokenIn }),
    );

    const items = res.ResourceDescriptions ?? [];
    if (items.length === 0) {
      return `No resources found for ${typeName} in region ${r}`;
    }

    const lines = items.map(formatItem);
    const more = res.NextToken ? `\nnext_token=${res.NextToken}  (pass to aws_query to get next page)` : "";
    return `${typeName} in ${r} (${items.length} found):\n` + lines.join("\n") + more;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not supported") || msg.includes("TypeNotFoundException") || msg.includes("UnsupportedAction")) {
      return `Cloud Control does not support listing ${typeName}. Try aws_get with a known identifier, or use a related type.`;
    }
    return `ERROR: ${msg}`;
  }
}

// ─── Tool 3: aws_get ──────────────────────────────────────────────────────────

export async function aws_get(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const typeName = params["type"]?.trim();
  const identifier = params["identifier"]?.trim();
  if (!typeName)   return "ERROR: type param is required";
  if (!identifier) return "ERROR: identifier param is required";
  if (/^(all|\*|list|any)$/i.test(identifier)) {
    return `ERROR: "${identifier}" is not a valid identifier. Use aws_query first to list resources and get their IDs, then call aws_get with a specific ID.`;
  }

  const r = params["region"]?.trim() || ctx.awsRegion;
  const client = new CloudControlClient(awsConfig(ctx, r));

  try {
    const res = await client.send(
      new GetResourceCommand({ TypeName: typeName, Identifier: identifier }),
    );

    const props = res.ResourceDescription?.Properties;
    if (!props) return `No properties returned for ${typeName}/${identifier}`;

    try {
      return `${typeName}/${identifier}:\n${JSON.stringify(JSON.parse(props), null, 2).slice(0, 6_000)}`;
    } catch {
      return `${typeName}/${identifier}:\n${props.slice(0, 6_000)}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not supported") || msg.includes("UnsupportedAction")) {
      return `Cloud Control does not support ${typeName}. Try aws_query with a related CloudFormation type.`;
    }
    return `ERROR: ${msg}`;
  }
}

// ─── Tool 4: cw_metrics ──────────────────────────────────────────────────────

/**
 * Fetch CloudWatch metric statistics. No hardcoded Unit — automatically works
 * for all metric types (percentages, counts, bytes, milliseconds, etc.).
 */
export async function cw_metrics(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const namespace  = params["namespace"]?.trim();
  const metric     = params["metric"]?.trim();
  const rawDims = params["dimensions"];
  let dimensions: string | undefined;
  if (rawDims == null) {
    dimensions = undefined;
  } else if (Array.isArray(rawDims)) {
    dimensions = (rawDims as Array<Record<string, string>>)
      .map((d) => (d.Name && d.Value ? `${d.Name}=${d.Value}` : ""))
      .filter(Boolean)
      .join(",") || undefined;
  } else if (typeof rawDims === "object") {
    dimensions = Object.entries(rawDims as Record<string, string>)
      .map(([k, v]) => `${k}=${v}`)
      .join(",") || undefined;
  } else {
    dimensions = String(rawDims).trim() || undefined;
  }
  if (!namespace) return "ERROR: namespace param required (e.g. AWS/EC2)";
  if (!metric)    return "ERROR: metric param required (e.g. CPUUtilization)";

  const r           = params["region"]?.trim() || ctx.awsRegion;
  const sinceHours  = parseFloat(params["since_hours"]  ?? "3");
  const periodMin   = parseInt(params["period_minutes"] ?? "5",  10);
  const stat        = (params["statistic"] ?? "Average") as Statistic;

  const dims = (dimensions ?? "").split(",").filter(Boolean).map((kv) => {
    const [Name, Value] = kv.split("=");
    return { Name: Name?.trim() ?? "", Value: Value?.trim() ?? "" };
  }).filter((d) => d.Name && d.Value);

  const EndTime   = new Date();
  const StartTime = new Date(EndTime.getTime() - sinceHours * 3_600_000);

  try {
    const client = new CloudWatchClient(awsConfig(ctx, r));
    // NOTE: Do NOT pass Unit param — let CloudWatch return the metric's native unit.
    // Passing Unit:Percent would filter out non-percentage metrics like counts, bytes, ms.
    const res = await client.send(new GetMetricStatisticsCommand({
      Namespace:  namespace,
      MetricName: metric,
      Dimensions: dims,
      StartTime,
      EndTime,
      Period:     periodMin * 60,
      Statistics: [stat],
    }));

    const points = (res.Datapoints ?? [])
      .sort((a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0));

    if (points.length === 0) {
      return (
        `No datapoints for ${namespace}/${metric} (dims=${dimensions ?? "none"}) last ${sinceHours}h in ${r}.\n` +
        `Run this to verify what metrics actually exist:\n` +
        `  aws cloudwatch list-metrics --namespace ${namespace}${dims.length > 0 ? ` --dimensions Name=${dims[0].Name},Value=${dims[0].Value}` : ""} --region ${r}\n` +
        `Then retry cw_metrics with the exact dimension names/values shown above.`
      );
    }

    // Detect unit from first datapoint
    const unit = points[0]?.Unit ?? "None";

    const rows = points.map((p) => {
      const ts  = p.Timestamp?.toISOString().slice(11, 19) ?? "?";
      const val = (p[stat as keyof typeof p] as number | undefined)?.toFixed(2) ?? "?";
      return `${ts}  ${val}`;
    });

    const values = points.map((p) => (p[stat as keyof typeof p] as number | undefined) ?? 0);
    const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
    const max = Math.max(...values).toFixed(2);
    const min = Math.min(...values).toFixed(2);

    return [
      `${namespace}/${metric}  dims=${dimensions ?? "none"}  last ${sinceHours}h  period=${periodMin}m  stat=${stat}  unit=${unit}`,
      `avg=${avg}  max=${max}  min=${min}  points=${points.length}`,
      ...rows,
    ].join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 5: cw_logs ─────────────────────────────────────────────────────────

export async function cw_logs(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const logGroupParam   = params["log_group"]?.trim();
  const filterPattern   = params["filter_pattern"]?.trim() ?? "";
  const sinceHours      = parseFloat(params["since_hours"] ?? "1");
  const limit           = Math.min(parseInt(params["limit"] ?? "50", 10), 100);
  const r               = params["region"]?.trim() || ctx.awsRegion;

  if (!logGroupParam) return "ERROR: log_group param required";

  const client    = new CloudWatchLogsClient(awsConfig(ctx, r));
  const startTime = Date.now() - Math.round(sinceHours * 3_600_000);

  // Resolve log group — try exact name first, then prefix search.
  let logGroupName = logGroupParam;
  if (!logGroupParam.startsWith("/")) {
    try {
      const desc = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupParam, limit: 5 }));
      const found = desc.logGroups?.[0]?.logGroupName;
      if (found) logGroupName = found;
    } catch {
      // use as-is
    }
  }

  try {
    const res = await client.send(new FilterLogEventsCommand({
      logGroupName,
      filterPattern: filterPattern || undefined,
      startTime,
      limit,
    }));

    const events = res.events ?? [];
    if (events.length === 0) {
      return `No logs matched in ${logGroupName} (filter="${filterPattern}", last ${sinceHours}h)`;
    }

    const lines = events.map((e) => {
      const ts  = e.timestamp ? new Date(e.timestamp).toISOString() : "?";
      const msg = (e.message ?? "").trim();
      const lvl = msg.match(/\b(ERROR|WARN|INFO|DEBUG|CRITICAL|FATAL)\b/i)?.[1]?.toUpperCase() ?? "";
      return `${ts}${lvl ? "  " + lvl : ""}  ${msg.slice(0, 500)}`;
    });

    return [`log_group=${logGroupName}  filter="${filterPattern}"  last ${sinceHours}h  (${events.length} events)`, ...lines].join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 6: ec2_exec (SSM SDK — no AWS CLI needed) ─────────────────────────

export async function ec2_exec(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const instanceId = params["instance_id"]?.trim();
  const command    = params["command"]?.trim();
  const r          = params["region"]?.trim() || ctx.awsRegion;

  if (!instanceId) return "ERROR: instance_id param is required";
  if (!command)    return "ERROR: command param is required";
  if (!isSafe(command)) return `BLOCKED: command matches safety blocklist — "${command}"`;

  const ssm = new SSMClient(awsConfig(ctx, r));

  try {
    // Send the command via SSM SDK
    const sendRes = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
      TimeoutSeconds: 60,
    }));

    const commandId = sendRes.Command?.CommandId;
    if (!commandId) return `ERROR: no CommandId in SSM response`;

    // Poll GetCommandInvocation until terminal state (max ~45 s).
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise<void>((res) => setTimeout(res, 3_000));

      try {
        const inv = await ssm.send(new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }));

        const status = inv.Status ?? "";
        if (status === "Success" || status === "Failed" || status === "Cancelled" || status === "TimedOut") {
          const stdout = (inv.StandardOutputContent ?? "").trim();
          const stderr = (inv.StandardErrorContent  ?? "").trim();
          const lines: string[] = [`EC2_EXEC status=${status} instance=${instanceId} cmd="${command}"`];
          if (stdout) lines.push(stdout);
          if (stderr) lines.push(`STDERR: ${stderr}`);
          return lines.join("\n").slice(0, 6_000);
        }
      } catch {
        // invocation not registered yet — keep trying
      }
    }

    return `TIMEOUT: SSM command "${commandId}" did not complete within 45 s on ${instanceId}`;
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 7: pi_top_sql ─────────────────────────────────────────────────────

const PI_VALID_PERIODS = [1, 60, 300, 3600] as const;
function snapPeriod(seconds: number): number {
  return PI_VALID_PERIODS.reduce<number>((best, p) => (p <= seconds ? p : best), 60);
}

export async function pi_top_sql(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const instanceId = params["instance"]?.trim();
  if (!instanceId) return `ERROR: instance param required (DB instance identifier)`;

  const region = params["region"]?.trim() || ctx.awsRegion;
  const sinceHours = Math.max(0.5, parseFloat(params["since_hours"] ?? "1"));
  const topN = parseInt(params["top"] ?? "10", 10);

  const cfg = awsConfig(ctx, region);

  const rds = new RDSClient(cfg);
  let dbiResourceId: string;
  try {
    const resp = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
    const inst = resp.DBInstances?.[0];
    if (!inst?.DbiResourceId) return `ERROR: instance "${instanceId}" not found or missing DbiResourceId`;
    dbiResourceId = inst.DbiResourceId;
  } catch (e) {
    return `ERROR resolving DbiResourceId for "${instanceId}": ${e instanceof Error ? e.message : String(e)}`;
  }

  const pi = new PIClient(cfg);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - sinceHours * 3600 * 1000);
  const periodInSeconds = snapPeriod(Math.round(sinceHours * 3600));

  try {
    const resp = await pi.send(
      new DescribeDimensionKeysCommand({
        ServiceType: "RDS",
        Identifier: dbiResourceId,
        StartTime: startTime,
        EndTime: endTime,
        Metric: "db.load.avg",
        PeriodInSeconds: periodInSeconds,
        GroupBy: { Group: "db.sql_tokenized", Limit: topN },
      }),
    );

    const keys = resp.Keys ?? [];
    if (keys.length === 0) {
      return `No Top SQL data returned for "${instanceId}" over the last ${sinceHours}h. ` +
        `Performance Insights may not be enabled on this instance.`;
    }

    const rows = keys.map((k, i) => {
      const load = (k.Total ?? 0).toFixed(3);
      const sql = (k.Dimensions?.["db.sql_tokenized.statement"] ?? k.Dimensions?.["db.sql_tokenized.id"] ?? "N/A")
        .replace(/\s+/g, " ")
        .slice(0, 500);
      return `${i + 1}. AAS=${load}  ${sql}`;
    });

    return (
      `Top ${keys.length} SQL by DB Load (AAS) for "${instanceId}" — last ${sinceHours}h (period=${periodInSeconds}s):\n\n` +
      rows.join("\n\n")
    );
  } catch (e) {
    return `ERROR querying Performance Insights for "${instanceId}": ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool 8: ecs_describe ────────────────────────────────────────────────────

/**
 * Describe ECS clusters, services, tasks, and deployments.
 * The LLM can drill from cluster → service → tasks.
 */
export async function ecs_describe(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const r       = params["region"]?.trim() || ctx.awsRegion;
  const cluster = params["cluster"]?.trim();
  const service = params["service"]?.trim();
  const taskId  = params["task_id"]?.trim();
  const ecs     = new ECSClient(awsConfig(ctx, r));

  try {
    // If no cluster specified, list all clusters
    if (!cluster) {
      const res = await ecs.send(new ListClustersCommand({}));
      const arns = res.clusterArns ?? [];
      if (arns.length === 0) return `No ECS clusters found in ${r}`;

      const desc = await ecs.send(new DescribeClustersCommand({ clusters: arns }));
      const rows = (desc.clusters ?? []).map((c) => {
        return `${c.clusterName}  status=${c.status}  services=${c.activeServicesCount}  tasks=${c.runningTasksCount}  pending=${c.pendingTasksCount}`;
      });
      return `ECS Clusters in ${r} (${rows.length}):\n` + rows.join("\n");
    }

    // If task_id specified, describe specific tasks
    if (taskId) {
      const taskIds = taskId.split(",").map((t) => t.trim());
      const desc = await ecs.send(new DescribeTasksCommand({ cluster, tasks: taskIds }));
      const tasks = desc.tasks ?? [];
      if (tasks.length === 0) return `No tasks found for IDs: ${taskId} in cluster ${cluster}`;

      const rows = tasks.map((t) => {
        const containers = (t.containers ?? []).map((c) => {
          return `  container=${c.name} status=${c.lastStatus} health=${c.healthStatus ?? "N/A"} exitCode=${c.exitCode ?? "N/A"} reason=${c.reason ?? "N/A"}`;
        }).join("\n");
        return `task=${t.taskArn?.split("/").pop()}  status=${t.lastStatus}  desiredStatus=${t.desiredStatus}  startedAt=${t.startedAt?.toISOString() ?? "N/A"}  stoppedAt=${t.stoppedAt?.toISOString() ?? "N/A"}  stoppedReason=${t.stoppedReason ?? "N/A"}\n${containers}`;
      });
      return `ECS Tasks in ${cluster}:\n` + rows.join("\n\n");
    }

    // If service specified, describe that service
    if (service) {
      const desc = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
      const svcs = desc.services ?? [];
      if (svcs.length === 0) return `Service "${service}" not found in cluster "${cluster}"`;

      const s = svcs[0];
      const deployments = (s.deployments ?? []).map((d) => {
        return `  deployment=${d.id}  status=${d.status}  desired=${d.desiredCount}  running=${d.runningCount}  pending=${d.pendingCount}  rollout=${d.rolloutState ?? "N/A"}  taskDef=${d.taskDefinition?.split("/").pop()}  createdAt=${d.createdAt?.toISOString()}`;
      }).join("\n");

      const events = (s.events ?? []).slice(0, 10).map((e) => {
        return `  ${e.createdAt?.toISOString()}  ${e.message}`;
      }).join("\n");

      // List recent tasks for this service
      let taskInfo = "";
      try {
        const taskList = await ecs.send(new ListTasksCommand({ cluster, serviceName: service, maxResults: 10 }));
        const taskArns = taskList.taskArns ?? [];
        if (taskArns.length > 0) {
          const taskDesc = await ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns }));
          taskInfo = "\n\nTasks:\n" + (taskDesc.tasks ?? []).map((t) => {
            const age = t.startedAt ? `${Math.round((Date.now() - t.startedAt.getTime()) / 60000)}m ago` : "N/A";
            const containers = (t.containers ?? []).map((c) => `${c.name}:${c.lastStatus}`).join(", ");
            return `  ${t.taskArn?.split("/").pop()}  status=${t.lastStatus}  started=${age}  containers=[${containers}]  stoppedReason=${t.stoppedReason ?? "N/A"}`;
          }).join("\n");
        }
      } catch { /* task list optional */ }

      return [
        `ECS Service: ${s.serviceName}  cluster=${cluster}  status=${s.status}`,
        `desired=${s.desiredCount}  running=${s.runningCount}  pending=${s.pendingCount}`,
        `taskDef=${s.taskDefinition?.split("/").pop()}  launchType=${s.launchType}`,
        `healthCheck=${s.healthCheckGracePeriodSeconds ?? 0}s`,
        `\nDeployments:\n${deployments}`,
        `\nRecent Events:\n${events}`,
        taskInfo,
      ].join("\n");
    }

    // List services in cluster
    const listRes = await ecs.send(new ListServicesCommand({ cluster, maxResults: 50 }));
    const serviceArns = listRes.serviceArns ?? [];
    if (serviceArns.length === 0) return `No services found in cluster "${cluster}" in ${r}`;

    const desc = await ecs.send(new DescribeServicesCommand({ cluster, services: serviceArns.slice(0, 10) }));
    const rows = (desc.services ?? []).map((s) => {
      const deployStatus = s.deployments?.[0]?.rolloutState ?? s.deployments?.[0]?.status ?? "N/A";
      return `${s.serviceName}  status=${s.status}  desired=${s.desiredCount}  running=${s.runningCount}  pending=${s.pendingCount}  deploy=${deployStatus}`;
    });
    return `ECS Services in ${cluster} (${rows.length}):\n` + rows.join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 9: elb_health ─────────────────────────────────────────────────────

/**
 * Check ALB/NLB target group health — critical for debugging 5XX errors.
 */
export async function elb_health(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const r              = params["region"]?.trim() || ctx.awsRegion;
  const targetGroup    = params["target_group"]?.trim();
  const loadBalancer   = params["load_balancer"]?.trim();
  const elb            = new ElasticLoadBalancingV2Client(awsConfig(ctx, r));

  try {
    // If load_balancer name/ARN given, find its target groups
    if (loadBalancer && !targetGroup) {
      // First resolve the LB
      let lbArn = loadBalancer;
      if (!loadBalancer.startsWith("arn:")) {
        const lbs = await elb.send(new DescribeLoadBalancersCommand({ Names: [loadBalancer] }));
        lbArn = lbs.LoadBalancers?.[0]?.LoadBalancerArn ?? "";
        if (!lbArn) return `Load balancer "${loadBalancer}" not found in ${r}`;
      }

      // Get target groups for this LB
      const tgs = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn }));
      const groups = tgs.TargetGroups ?? [];
      if (groups.length === 0) return `No target groups for LB "${loadBalancer}" in ${r}`;

      const results: string[] = [];
      for (const tg of groups) {
        const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
        const targets = (health.TargetHealthDescriptions ?? []).map((t) => {
          const state = t.TargetHealth?.State ?? "unknown";
          const reason = t.TargetHealth?.Reason ?? "";
          const desc = t.TargetHealth?.Description ?? "";
          return `    ${t.Target?.Id}:${t.Target?.Port}  state=${state}${reason ? "  reason=" + reason : ""}${desc ? "  desc=" + desc : ""}`;
        });

        const healthy   = targets.filter((t) => t.includes("state=healthy")).length;
        const unhealthy = targets.filter((t) => !t.includes("state=healthy")).length;
        results.push(
          `Target Group: ${tg.TargetGroupName}  protocol=${tg.Protocol}  port=${tg.Port}  healthy=${healthy}  unhealthy=${unhealthy}\n` +
          `  healthCheck: ${tg.HealthCheckProtocol}:${tg.HealthCheckPort}${tg.HealthCheckPath ?? ""}  interval=${tg.HealthCheckIntervalSeconds}s  threshold=${tg.HealthyThresholdCount}/${tg.UnhealthyThresholdCount}\n` +
          targets.join("\n")
        );
      }
      return results.join("\n\n");
    }

    // Direct target group lookup
    if (targetGroup) {
      let tgArn = targetGroup;
      if (!targetGroup.startsWith("arn:")) {
        const tgs = await elb.send(new DescribeTargetGroupsCommand({ Names: [targetGroup] }));
        tgArn = tgs.TargetGroups?.[0]?.TargetGroupArn ?? "";
        if (!tgArn) return `Target group "${targetGroup}" not found in ${r}`;
      }

      const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }));
      const targets = (health.TargetHealthDescriptions ?? []).map((t) => {
        const state = t.TargetHealth?.State ?? "unknown";
        const reason = t.TargetHealth?.Reason ?? "";
        const desc = t.TargetHealth?.Description ?? "";
        return `  ${t.Target?.Id}:${t.Target?.Port}  state=${state}${reason ? "  reason=" + reason : ""}${desc ? "  desc=" + desc : ""}`;
      });

      const healthy   = targets.filter((t) => t.includes("state=healthy")).length;
      const unhealthy = targets.filter((t) => !t.includes("state=healthy")).length;
      return `Target Group Health (${targetGroup}) — healthy=${healthy}  unhealthy=${unhealthy}:\n` + targets.join("\n");
    }

    return "ERROR: provide target_group or load_balancer param";
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 10: cloudtrail ────────────────────────────────────────────────────

/**
 * Look up recent AWS API events — deployments, config changes, permission changes.
 * Critical for answering "what changed before this outage?"
 */
export async function cloudtrail_lookup(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const r          = params["region"]?.trim() || ctx.awsRegion;
  const sinceHours = parseFloat(params["since_hours"] ?? "3");
  const maxResults = Math.min(parseInt(params["max_results"] ?? "25", 10), 50);
  const eventName  = params["event_name"]?.trim();
  const resource   = params["resource_name"]?.trim();
  const username   = params["username"]?.trim();
  const ct         = new CloudTrailClient(awsConfig(ctx, r));

  const StartTime = new Date(Date.now() - sinceHours * 3_600_000);
  const EndTime   = new Date();

  // Build lookup attributes
  const LookupAttributes: LookupAttribute[] = [];
  if (eventName) LookupAttributes.push({ AttributeKey: "EventName", AttributeValue: eventName });
  if (resource)  LookupAttributes.push({ AttributeKey: "ResourceName", AttributeValue: resource });
  if (username)  LookupAttributes.push({ AttributeKey: "Username", AttributeValue: username });

  try {
    const res = await ct.send(new LookupEventsCommand({
      StartTime,
      EndTime,
      MaxResults: maxResults,
      LookupAttributes: LookupAttributes.length > 0 ? LookupAttributes : undefined,
    }));

    const events = res.Events ?? [];
    if (events.length === 0) {
      return `No CloudTrail events found in ${r} last ${sinceHours}h${eventName ? ` for event=${eventName}` : ""}${resource ? ` for resource=${resource}` : ""}`;
    }

    const rows = events.map((e) => {
      const resources = (e.Resources ?? []).map((r) => `${r.ResourceType}:${r.ResourceName}`).join(", ");
      return `${e.EventTime?.toISOString()}  ${e.EventName}  by=${e.Username ?? "N/A"}  resources=[${resources}]  source=${e.EventSource ?? "N/A"}`;
    });

    return `CloudTrail events in ${r} last ${sinceHours}h (${events.length} events):\n` + rows.join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 11: asg_activity ──────────────────────────────────────────────────

/**
 * Auto Scaling group recent scaling activities and configuration.
 */
export async function asg_activity(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const r       = params["region"]?.trim() || ctx.awsRegion;
  const asgName = params["asg_name"]?.trim();
  const asc     = new AutoScalingClient(awsConfig(ctx, r));

  try {
    if (!asgName) {
      // List all ASGs
      const res = await asc.send(new DescribeAutoScalingGroupsCommand({ MaxRecords: 50 }));
      const groups = res.AutoScalingGroups ?? [];
      if (groups.length === 0) return `No Auto Scaling groups found in ${r}`;

      const rows = groups.map((g) => {
        return `${g.AutoScalingGroupName}  desired=${g.DesiredCapacity}  min=${g.MinSize}  max=${g.MaxSize}  instances=${g.Instances?.length ?? 0}  health=[${(g.Instances ?? []).map((i) => `${i.InstanceId}:${i.HealthStatus}`).join(", ")}]`;
      });
      return `Auto Scaling Groups in ${r} (${rows.length}):\n` + rows.join("\n");
    }

    // Get ASG details + recent activities
    const [descRes, actRes] = await Promise.all([
      asc.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] })),
      asc.send(new DescribeScalingActivitiesCommand({ AutoScalingGroupName: asgName, MaxRecords: 20 })),
    ]);

    const group = descRes.AutoScalingGroups?.[0];
    if (!group) return `ASG "${asgName}" not found in ${r}`;

    const instances = (group.Instances ?? []).map((i) => {
      return `  ${i.InstanceId}  az=${i.AvailabilityZone}  lifecycle=${i.LifecycleState}  health=${i.HealthStatus}`;
    }).join("\n");

    const activities = (actRes.Activities ?? []).map((a) => {
      return `  ${a.StartTime?.toISOString()}  status=${a.StatusCode}  cause=${(a.Cause ?? "").slice(0, 200)}`;
    }).join("\n");

    return [
      `ASG: ${group.AutoScalingGroupName}  desired=${group.DesiredCapacity}  min=${group.MinSize}  max=${group.MaxSize}`,
      `launchTemplate=${group.LaunchTemplate?.LaunchTemplateName ?? group.LaunchConfigurationName ?? "N/A"}`,
      `\nInstances (${group.Instances?.length ?? 0}):\n${instances}`,
      `\nRecent Scaling Activities:\n${activities}`,
    ].join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 12: route53_check ─────────────────────────────────────────────────

/**
 * Look up DNS records in Route 53 hosted zones.
 */
export async function route53_check(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const domain    = params["domain"]?.trim();
  const zoneId    = params["zone_id"]?.trim();
  const r53       = new Route53Client(awsConfig(ctx));

  try {
    // If no zone_id, list hosted zones or find one matching the domain
    let resolvedZoneId = zoneId;
    if (!resolvedZoneId) {
      const zones = await r53.send(new ListHostedZonesCommand({}));
      const allZones = zones.HostedZones ?? [];

      if (!domain) {
        // Just list zones
        if (allZones.length === 0) return "No Route 53 hosted zones found";
        const rows = allZones.map((z) => `${z.Id?.replace("/hostedzone/", "")}  ${z.Name}  records=${z.ResourceRecordSetCount}  private=${z.Config?.PrivateZone ?? false}`);
        return `Route 53 Hosted Zones (${rows.length}):\n` + rows.join("\n");
      }

      // Find zone matching domain
      const match = allZones.find((z) => domain.endsWith(z.Name?.replace(/\.$/, "") ?? ""));
      if (!match) return `No hosted zone found for domain "${domain}". Available zones: ${allZones.map((z) => z.Name).join(", ")}`;
      resolvedZoneId = match.Id?.replace("/hostedzone/", "") ?? "";
    }

    if (!resolvedZoneId) return "ERROR: could not resolve zone_id";

    const records = await r53.send(new ListResourceRecordSetsCommand({
      HostedZoneId: resolvedZoneId,
      StartRecordName: domain,
      MaxItems: 20,
    }));

    const sets = records.ResourceRecordSets ?? [];
    if (sets.length === 0) return `No records found in zone ${resolvedZoneId}`;

    const rows = sets
      .filter((rs) => !domain || rs.Name?.includes(domain))
      .map((rs) => {
        const values = rs.ResourceRecords?.map((rr) => rr.Value).join(", ") ?? "";
        const alias = rs.AliasTarget ? `ALIAS→${rs.AliasTarget.DNSName}` : "";
        return `${rs.Name}  ${rs.Type}  TTL=${rs.TTL ?? "N/A"}  ${values}${alias}`;
      });

    return `Route 53 Records (zone=${resolvedZoneId}):\n` + rows.join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 13: k8s_pods ──────────────────────────────────────────────────────

/**
 * Structured pod status — detects CrashLoopBackOff, OOMKilled, restarts,
 * pending pods, and image pull errors.
 */
export async function k8s_pods(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const namespace = params["namespace"]?.trim() || "default";
  const selector  = params["selector"]?.trim();
  const name      = params["name"]?.trim();

  let cmd = `kubectl get pods -n ${namespace} -o json`;
  if (selector) cmd += ` -l ${selector}`;
  if (name) cmd += ` --field-selector metadata.name=${name}`;

  if (ctx.k8sContext) cmd += ` --context ${ctx.k8sContext}`;

  const raw = await shell(cmd, 15_000);
  try {
    const data = JSON.parse(raw) as {
      items: Array<{
        metadata: { name: string; namespace: string; creationTimestamp: string };
        status: {
          phase: string;
          conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          containerStatuses?: Array<{
            name: string;
            ready: boolean;
            restartCount: number;
            state: Record<string, { reason?: string; exitCode?: number; startedAt?: string; message?: string }>;
            lastState?: Record<string, { reason?: string; exitCode?: number; finishedAt?: string }>;
          }>;
        };
        spec: { nodeName?: string; containers: Array<{ name: string; image: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }> };
      }>;
    };

    const pods = data.items ?? [];
    if (pods.length === 0) return `No pods found in namespace=${namespace}${selector ? ` selector=${selector}` : ""}`;

    const rows = pods.map((p) => {
      const containers = (p.status.containerStatuses ?? []).map((c) => {
        const stateKey = Object.keys(c.state)[0] ?? "unknown";
        const stateDetail = c.state[stateKey];
        const reason = stateDetail?.reason ?? "";
        const exitCode = stateDetail?.exitCode;
        const lastReason = c.lastState ? Object.values(c.lastState)[0]?.reason ?? "" : "";
        return `  container=${c.name} ready=${c.ready} restarts=${c.restartCount} state=${stateKey}${reason ? "/" + reason : ""}${exitCode !== undefined ? " exit=" + exitCode : ""}${lastReason ? " lastCrash=" + lastReason : ""}`;
      }).join("\n");

      const conditions = (p.status.conditions ?? [])
        .filter((c) => c.status === "False")
        .map((c) => `  condition=${c.type}=False reason=${c.reason ?? "N/A"} msg=${c.message?.slice(0, 100) ?? ""}`)
        .join("\n");

      const node = p.spec.nodeName ?? "unscheduled";
      const age = Math.round((Date.now() - new Date(p.metadata.creationTimestamp).getTime()) / 60000);

      return `pod=${p.metadata.name}  ns=${p.metadata.namespace}  phase=${p.status.phase}  node=${node}  age=${age}m\n${containers}${conditions ? "\n" + conditions : ""}`;
    });

    // Summary
    const phases: Record<string, number> = {};
    let totalRestarts = 0;
    let crashLoops = 0;
    for (const p of pods) {
      phases[p.status.phase] = (phases[p.status.phase] ?? 0) + 1;
      for (const c of p.status.containerStatuses ?? []) {
        totalRestarts += c.restartCount;
        const stateKey = Object.keys(c.state)[0];
        if (c.state[stateKey]?.reason === "CrashLoopBackOff") crashLoops++;
      }
    }

    const summary = `Pods in ${namespace} (${pods.length} total): ${Object.entries(phases).map(([k, v]) => `${k}=${v}`).join(" ")}  totalRestarts=${totalRestarts}  crashLoops=${crashLoops}`;

    return summary + "\n\n" + rows.join("\n\n");
  } catch {
    // Fallback: raw kubectl output (maybe kubectl returned an error)
    return raw;
  }
}

// ─── Tool 14: k8s_events ────────────────────────────────────────────────────

/**
 * Recent Kubernetes events — warnings, errors, scaling events, scheduling failures.
 */
export async function k8s_events(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const namespace = params["namespace"]?.trim();
  const severity  = params["severity"]?.trim()?.toLowerCase() ?? "warning"; // "warning" or "all"
  const since     = params["since"]?.trim() || "1h";
  const name      = params["involved_object"]?.trim();

  let cmd = `kubectl get events`;
  if (namespace && namespace !== "all") {
    cmd += ` -n ${namespace}`;
  } else {
    cmd += ` --all-namespaces`;
  }
  cmd += ` --sort-by=.lastTimestamp -o json`;
  if (ctx.k8sContext) cmd += ` --context ${ctx.k8sContext}`;

  const raw = await shell(cmd, 15_000);
  try {
    const data = JSON.parse(raw) as {
      items: Array<{
        type: string;
        reason: string;
        message: string;
        involvedObject: { kind: string; name: string; namespace?: string };
        firstTimestamp?: string;
        lastTimestamp?: string;
        count?: number;
        source?: { component: string };
      }>;
    };

    let events = data.items ?? [];

    // Filter by severity
    if (severity === "warning") {
      events = events.filter((e) => e.type === "Warning");
    }

    // Filter by involved object name
    if (name) {
      events = events.filter((e) => e.involvedObject.name.includes(name));
    }

    // Filter by time
    const sinceMs = parseDuration(since);
    const cutoff = Date.now() - sinceMs;
    events = events.filter((e) => {
      const ts = e.lastTimestamp ? new Date(e.lastTimestamp).getTime() : 0;
      return ts > cutoff;
    });

    if (events.length === 0) {
      return `No ${severity} events found${namespace ? ` in namespace=${namespace}` : ""}${name ? ` for ${name}` : ""} in last ${since}`;
    }

    // Take latest 50
    events = events.slice(-50);

    const rows = events.map((e) => {
      return `${e.lastTimestamp ?? "?"}  ${e.type}  ${e.reason}  ${e.involvedObject.kind}/${e.involvedObject.name}${e.involvedObject.namespace ? " ns=" + e.involvedObject.namespace : ""}  count=${e.count ?? 1}  msg=${e.message.slice(0, 200)}`;
    });

    return `K8s Events (${events.length}, severity=${severity}, last ${since}):\n` + rows.join("\n");
  } catch {
    return raw;
  }
}

// ─── Tool 15: k8s_logs ──────────────────────────────────────────────────────

/**
 * Fetch logs from a pod/container with optional grep filtering.
 */
export async function k8s_logs(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const pod       = params["pod"]?.trim();
  const namespace = params["namespace"]?.trim() || "default";
  const container = params["container"]?.trim();
  const since     = params["since"]?.trim() || "1h";
  const grep      = params["grep"]?.trim();
  const tail      = params["tail"]?.trim() || "100";
  const previous  = params["previous"]?.trim() === "true";

  if (!pod) return "ERROR: pod param is required";

  let cmd = `kubectl logs ${pod} -n ${namespace} --since=${since} --tail=${tail}`;
  if (container) cmd += ` -c ${container}`;
  if (previous) cmd += ` --previous`;
  if (ctx.k8sContext) cmd += ` --context ${ctx.k8sContext}`;
  if (grep) cmd += ` | grep -i "${grep}"`;

  const raw = await shell(cmd, 15_000);
  if (!raw || raw === "(no output)") {
    return `No logs for pod=${pod} container=${container ?? "all"} in ns=${namespace} last ${since}${grep ? ` matching "${grep}"` : ""}`;
  }

  return `Logs: pod=${pod} ns=${namespace}${container ? " container=" + container : ""} last ${since}${grep ? ` grep="${grep}"` : ""}${previous ? " (previous)" : ""}:\n${raw}`;
}

// ─── Tool 16: aws_cli ────────────────────────────────────────────────────────

/**
 * Run a read-only AWS CLI command with credential injection from context.
 *
 * Why this exists alongside SDK tools:
 *   - SDK tools cover ~15 key APIs with structured output
 *   - AWS CLI covers ALL 300+ AWS services (xray, health, guardduty, config,
 *     securityhub, inspector, servicediscovery, support, pricing, ce, etc.)
 *   - Some APIs are awkward to use via SDK but trivial via CLI
 *     (e.g. "aws logs tail", "aws xray get-trace-summaries", "aws health describe-events")
 *
 * Safety: only read-only subcommands allowed (describe, list, get, query, show,
 * tail, filter, search, export, view, check, scan, find, lookup, fetch).
 * Any mutating verb is blocked.
 *
 * Credentials from ctx.awsCredentials are injected as env vars so the CLI
 * uses the tenant account even if ~/.aws/credentials points elsewhere.
 */
export async function aws_cli(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  let command = params["command"]?.trim() ?? "";
  if (!command) return "ERROR: command param is required (e.g. \"aws elasticache describe-replication-groups --replication-group-id <name>\")";

  // Sanitize: strip surrounding quotes/backticks the LLM sometimes adds
  command = command.replace(/^[`"']+|[`"']+$/g, "").trim();
  // Collapse newlines and multiple spaces into single spaces
  command = command.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();

  // Must start with "aws"
  if (!/^\s*aws\s+/.test(command)) {
    return `ERROR: command must start with "aws" (e.g. "aws ecs describe-services ...")`;
  }

  // Read-only allowlist — only these subcommand verbs are permitted
  const READ_ONLY_VERBS = [
    "describe", "list", "get", "query", "show", "tail",
    "filter", "search", "export", "view", "check", "scan",
    "find", "lookup", "fetch", "summarize", "analyze", "validate",
  ];

  // Extract the subcommand (3rd word: "aws <service> <subcommand>")
  const parts = command.trim().split(/\s+/);
  const subcommand = parts[2]?.toLowerCase() ?? "";

  const isReadOnly = READ_ONLY_VERBS.some((v) => subcommand.startsWith(v));
  if (!isReadOnly) {
    return (
      `BLOCKED: "${subcommand}" is not a read-only subcommand.\n` +
      `Allowed verbs: ${READ_ONLY_VERBS.join(", ")}.\n` +
      `Examples: describe-services, list-clusters, get-trace-summaries, list-findings`
    );
  }

  // Ensure --output json unless user specified something else
  const finalCmd = command.includes("--output") ? command : `${command} --output json`;

  // Inject region if not already specified
  const withRegion = (finalCmd.includes("--region") || finalCmd.includes("global"))
    ? finalCmd
    : `${finalCmd} --region ${ctx.awsRegion}`;

  // Build env with tenant credentials injected — overrides ~/.aws/credentials
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (ctx.awsCredentials) {
    env["AWS_ACCESS_KEY_ID"]     = ctx.awsCredentials.accessKeyId;
    env["AWS_SECRET_ACCESS_KEY"] = ctx.awsCredentials.secretAccessKey;
    if (ctx.awsCredentials.sessionToken) {
      env["AWS_SESSION_TOKEN"] = ctx.awsCredentials.sessionToken;
    }
    // Clear profile so explicit creds take precedence
    delete env["AWS_PROFILE"];
    delete env["AWS_DEFAULT_PROFILE"];
  }

  return new Promise((resolve) => {
    exec(withRegion, { timeout: 30_000, env }, (_err, stdout, stderr) => {
      // AWS CLI writes errors to stderr. Always resolve — errors are evidence for the LLM.
      const out = stdout?.trim();
      const err = stderr?.trim();

      if (out && out.length > 0) {
        // Pretty-print JSON if possible
        try {
          const parsed = JSON.parse(out);
          // JSON.parse("null") returns JS null — not useful, treat as no output
          if (parsed === null || parsed === undefined) {
            resolve(err ? `AWS CLI ERROR: ${err.slice(0, 2_000)}` : "(command returned empty/null response)");
          } else {
            resolve(JSON.stringify(parsed, null, 2).slice(0, 8_000));
          }
        } catch {
          resolve(out.slice(0, 8_000));
        }
      } else if (err) {
        resolve(`AWS CLI ERROR (cmd: ${withRegion.slice(0, 200)}): ${err.slice(0, 2_000)}`);
      } else {
        resolve("(no output)");
      }
    });
  });
}

// ─── Tool 17: mcp_tool ──────────────────────────────────────────────────────

export async function mcp_tool(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const toolName = params["name"]?.trim();
  if (!toolName) {
    return `ERROR: name param required — specify the MCP tool to call (e.g. name="list_load_balancers")`;
  }
  if (!ctx.mcpService?.isConnected()) {
    return (
      `ERROR: AWS MCP server not connected. ` +
      `Configure with AWS_MCP_SERVERS=cloudwatch,cloudtrail`
    );
  }

  const { name: _name, ...rest } = params;
  return ctx.mcpService.callTool(toolName, rest as Record<string, unknown>);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse "30m", "1h", "6h", "24h" to milliseconds. */
function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/);
  if (!match) return 3_600_000; // default 1h
  const val = parseFloat(match[1]);
  switch (match[2]) {
    case "m": return val * 60_000;
    case "h": return val * 3_600_000;
    case "d": return val * 86_400_000;
    default: return 3_600_000;
  }
}

// ─── Tool catalog (shown to LLM in every prompt) ────────────────────────────

export function buildToolCatalog(mcpTools?: AwsMcpTool[]): string {
  const base = `TOOLS:

1. run_command(command: string)
   Execute any read-only shell command. k8s context auto-injected for kubectl/helm.
   Use for: dig, nslookup, curl, nc, ping, openssl, ssh, traceroute.
   Do NOT use for AWS CLI or kubectl (use dedicated tools below).

2. aws_query(type: string, region?: string, max_results?: string, filter?: string, name_filter?: string)
   List AWS resources by CloudFormation type via Cloud Control SDK.
   filter: optional JSON ResourceModel string to scope results, e.g. '{"VpcId":"vpc-0abc"}'.
   name_filter: substring match against identifier + properties — auto-paginates ALL pages.

3. aws_get(type: string, identifier: string, region?: string)
   Fetch full properties of one AWS resource. identifier must be a real resource ID from aws_query.

4. ec2_exec(instance_id: string, command: string, region?: string)
   Run a command inside an EC2 instance via SSM SDK (no SSH key or AWS CLI needed).

5. cw_metrics(namespace: string, metric: string, dimensions?: string, since_hours?: string, period_minutes?: string, statistic?: string, region?: string)
   Fetch CloudWatch metric statistics. dimensions format: "Key=Value" or "Key1=V1,Key2=V2".
   Works for ALL metric types (counts, bytes, ms, percent — no unit restriction).
   ALB: namespace=AWS/ApplicationELB, dimension LoadBalancer=app/<name>/<hash> (ARN suffix after "loadbalancer/").
   Common ALB metrics: HTTPCode_Target_4XX_Count, HTTPCode_Target_5XX_Count, RequestCount, TargetResponseTime.
   Use statistic=Sum for counts, Average for rates/latency.

6. cw_logs(log_group: string, filter_pattern?: string, since_hours?: string, limit?: string, region?: string)
   Search CloudWatch Logs. log_group can be a full name or prefix (auto-discovered).
   limit defaults to 50, max 100.

7. pi_top_sql(instance: string, top?: string, since_hours?: string, region?: string)
   Top SQL queries by DB Load (Average Active Sessions) via Performance Insights API.
   instance = DB instance identifier (e.g. "comics-master-db"). top defaults to 10.

8. ecs_describe(cluster?: string, service?: string, task_id?: string, region?: string)
   ECS cluster/service/task inspection. Drill down: clusters → services → tasks.
   No params = list all clusters. cluster only = list services. cluster+service = full detail with deployments, events, tasks.
   cluster+task_id = specific task containers and stopped reasons.

9. elb_health(load_balancer?: string, target_group?: string, region?: string)
   ALB/NLB target group health. Shows healthy/unhealthy targets with reasons.
   load_balancer = name or ARN → lists all target groups + health.
   target_group = name or ARN → health for that specific group.

10. cloudtrail(event_name?: string, resource_name?: string, username?: string, since_hours?: string, max_results?: string, region?: string)
    Recent AWS API events from CloudTrail — deployments, config changes, permission changes.
    Use for: "what changed?", "who deployed?", "recent config changes".
    event_name examples: "UpdateService", "CreateDeployment", "PutScalingPolicy", "RunInstances".

11. asg_activity(asg_name?: string, region?: string)
    Auto Scaling group config and recent scaling activities.
    No asg_name = list all ASGs with instance health. With asg_name = details + scaling history.

12. route53_check(domain?: string, zone_id?: string)
    Route 53 DNS lookup. No params = list hosted zones. domain = find matching zone and records.

13. k8s_pods(namespace?: string, selector?: string, name?: string)
    Structured pod status with restart counts, CrashLoopBackOff detection, OOMKilled, exit codes.
    namespace defaults to "default". selector = label selector (e.g. "app=checkout-api").

14. k8s_events(namespace?: string, severity?: string, since?: string, involved_object?: string)
    Recent K8s events. severity="warning" (default) or "all". since="1h" (default).
    involved_object = filter by resource name.

15. k8s_logs(pod: string, namespace?: string, container?: string, since?: string, grep?: string, tail?: string, previous?: string)
    Pod logs with optional grep filtering. previous="true" for crashed container logs.

16. aws_cli(command: string)
    Run any read-only AWS CLI command. Credentials injected from context automatically.
    Only read-only subcommands allowed: describe, list, get, query, filter, search, tail, scan, lookup, analyze.
    Output is always --output json, region injected automatically.
    Use for services NOT covered by SDK tools: ElastiCache, X-Ray, GuardDuty, Security Hub,
    AWS Health, AWS Config, Inspector, Service Discovery, Support, Pricing, Trusted Advisor,
    WAF, Shield, CloudFormation events, ECR image scans, Secrets Manager, Parameter Store, etc.
    ElastiCache/Redis/Valkey (IMPORTANT — "cluster" may be ElastiCache, not ECS!):
      "aws elasticache describe-replication-groups --replication-group-id <name>"
      "aws elasticache describe-cache-clusters --cache-cluster-id <name> --show-cache-node-info"
      "aws elasticache describe-events --source-type replication-group --duration 60"
    Other examples:
      "aws xray get-trace-summaries --time-range-type EventTime --start-time 2026-04-02T10:00:00Z --end-time 2026-04-02T11:00:00Z"
      "aws health describe-events --filter eventStatusCodes=open"
      "aws guardduty list-findings --detector-id <id>"
      "aws configservice describe-compliance-by-resource --resource-type AWS::ECS::Service"
      "aws secretsmanager describe-secret --secret-id my-secret"
      "aws ssm get-parameter --name /my/param --with-decryption"
      "aws ecr describe-image-scan-findings --repository-name my-repo --image-id imageTag=latest"
      "aws logs tail /ecs/my-service --since 1h"
    Metric discovery (use when cw_metrics returns no datapoints):
      "aws cloudwatch list-metrics --namespace AWS/ElastiCache --dimensions Name=CacheClusterId,Value=<id>"
      "aws cloudwatch list-metrics --namespace AWS/ECS --dimensions Name=ClusterName,Value=<name>"
      "aws cloudwatch list-metrics --namespace AWS/ApplicationELB"
    This shows exactly what metrics + dimensions CloudWatch is publishing — fixes wrong dimension guesses.`;

  if (!mcpTools || mcpTools.length === 0) return base;

  const mcpSection = mcpTools
    .map((t, i) => {
      const paramList = t.params.length > 0 ? `(${t.params.join(", ")})` : "()";
      return `${17 + i}. mcp_tool  name="${t.name}"${paramList}\n   ${t.description}`;
    })
    .join("\n\n");

  return (
    base +
    `\n\n17+. mcp_tool(name: string, ...args)  [AWS MCP SERVER — prefer these over SDK tools when available]\n` +
    `   Call any AWS MCP server tool directly. Pass name= plus the tool's own parameters.\n` +
    `   Example: {"tool":"mcp_tool","params":{"name":"list_load_balancers","region":"ap-southeast-1"}}\n\n` +
    `   Available MCP tools:\n` +
    mcpSection
  );
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "run_command":       return run_command(params, ctx);
    case "aws_query":         return aws_query(params, ctx);
    case "aws_get":           return aws_get(params, ctx);
    case "ec2_exec":          return ec2_exec(params, ctx);
    case "cw_metrics":        return cw_metrics(params, ctx);
    case "cw_logs":           return cw_logs(params, ctx);
    case "pi_top_sql":        return pi_top_sql(params, ctx);
    case "ecs_describe":      return ecs_describe(params, ctx);
    case "elb_health":        return elb_health(params, ctx);
    case "cloudtrail":        return cloudtrail_lookup(params, ctx);
    case "cloudtrail_lookup": return cloudtrail_lookup(params, ctx);
    case "asg_activity":      return asg_activity(params, ctx);
    case "route53_check":     return route53_check(params, ctx);
    case "k8s_pods":          return k8s_pods(params, ctx);
    case "k8s_events":        return k8s_events(params, ctx);
    case "k8s_logs":          return k8s_logs(params, ctx);
    case "aws_cli":           return aws_cli(params, ctx);
    case "mcp_tool":          return mcp_tool(params, ctx);
    default: {
      // Auto-route MCP tool names
      if (ctx.mcpService?.isConnected()) {
        const known = ctx.mcpService.getDiscoveredTools().some((t) => t.name === name);
        if (known) return mcp_tool({ name, ...params }, ctx);
      }
      return `ERROR: Unknown tool "${name}". Available: run_command, aws_query, aws_get, ec2_exec, cw_metrics, cw_logs, pi_top_sql, ecs_describe, elb_health, cloudtrail, asg_activity, route53_check, k8s_pods, k8s_events, k8s_logs, aws_cli, mcp_tool`;
    }
  }
}
