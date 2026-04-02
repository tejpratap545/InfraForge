/**
 * diagnoseTools.ts
 *
 * Four generic primitives — the LLM generates all parameters dynamically.
 * No pre-defined cases. Works like Claude Code / Codex:
 *
 *   run_command   — any read-only shell command (kubectl, aws CLI, ssh, dig, nc …)
 *   aws_query     — Cloud Control ListResources for any AWS::* type
 *   aws_get       — Cloud Control GetResource for a specific resource
 *   ec2_exec      — run a command ON an EC2 instance via AWS SSM (no SSH key needed)
 *
 * The LLM decides WHAT to run at each step based on accumulated evidence.
 */

import { exec } from "node:child_process";
import {
  CloudControlClient,
  ListResourcesCommand,
  GetResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  StandardUnit,
  Statistic,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { AwsCredentials } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolContext {
  awsRegion: string;
  k8sContext?: string;
  /** Explicit AWS credentials. Falls back to SDK default chain if omitted. */
  awsCredentials?: AwsCredentials;
}

// ─── Safety blocklist for run_command ────────────────────────────────────────
// Only blocks destructive operations. All read/diagnostic commands pass.

const BLOCKED: RegExp[] = [
  /\brm\s+-[rf]/i,
  /\bformat\b/i,
  /\bfdisk\b/i,
  /^\s*aws\s+/i,           // AWS CLI — use aws_query / aws_get / ec2_exec / cw_metrics / cw_logs instead
  /kubectl\s+delete\b/i,
  /kubectl\s+apply\b/i,
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
      // Always resolve — errors are part of the output the LLM reasons about.
      resolve(combined.slice(0, 3_000) || "(no output)");
    });
  });
}

// ─── Tool 1: run_command ──────────────────────────────────────────────────────

/**
 * Execute any read-only shell command.
 * LLM generates the exact command string — kubectl, nslookup, dig, curl -I,
 * aws CLI, ping, nc, openssl s_client, etc.
 */
export async function run_command(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const cmd = params["command"]?.trim();
  if (!cmd) return "ERROR: command param is required";
  if (!isSafe(cmd)) {
    if (/^\s*aws\s+/i.test(cmd)) {
      return `BLOCKED: use SDK tools instead of AWS CLI — aws_query(type) to list, aws_get(type,id) to inspect, ec2_exec(id,cmd) to run inside EC2, cw_metrics/cw_logs for observability.`;
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

/**
 * List AWS resources of any CloudFormation type via Cloud Control API.
 * No AWS CLI required — uses the installed @aws-sdk/client-cloudcontrol.
 *
 * Examples:
 *   type=AWS::ElasticLoadBalancingV2::LoadBalancer
 *   type=AWS::EC2::SecurityGroup
 *   type=AWS::Route53::HostedZone
 *   type=AWS::CertificateManager::Certificate
 *   type=AWS::EKS::Cluster
 *   type=AWS::RDS::DBInstance
 */
export async function aws_query(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const typeName = params["type"]?.trim();
  if (!typeName) return "ERROR: type param is required (e.g. AWS::EC2::SecurityGroup)";

  const r          = params["region"]?.trim() || ctx.awsRegion;
  const maxResults  = Math.min(parseInt(params["max_results"] ?? "20", 10), 50);
  // Optional ResourceModel filter — JSON string scoping the list (e.g. '{"VpcId":"vpc-0abc"}')
  const filter      = params["filter"]?.trim() || undefined;

  const client = new CloudControlClient({ region: r, ...(ctx.awsCredentials && { credentials: ctx.awsCredentials }) });

  try {
    const res = await client.send(
      new ListResourcesCommand({ TypeName: typeName, MaxResults: maxResults, ResourceModel: filter }),
    );

    const items = res.ResourceDescriptions ?? [];
    if (items.length === 0) {
      return `No resources found for ${typeName} in region ${r}`;
    }

    const lines = items.map((item) => {
      const id = item.Identifier ?? "?";
      // Parse properties and show as compact JSON (single line, trimmed)
      let props = "";
      try {
        props = item.Properties ? JSON.stringify(JSON.parse(item.Properties)) : "";
      } catch {
        props = item.Properties ?? "";
      }
      return `${id}  ${props.slice(0, 400)}`;
    });

    return `${typeName} in ${r} (${items.length} found):\n` + lines.join("\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Many types aren't supported by Cloud Control — suggest aws CLI fallback
    if (msg.includes("not supported") || msg.includes("TypeNotFoundException") || msg.includes("UnsupportedAction")) {
      return `Cloud Control does not support listing ${typeName}. Try aws_get with a known identifier, or use a related type.`;
    }
    return `ERROR: ${msg}`;
  }
}

// ─── Tool 3: aws_get ──────────────────────────────────────────────────────────

/**
 * Get full properties of a specific AWS resource via Cloud Control.
 * The identifier comes from aws_query results.
 *
 * Examples:
 *   type=AWS::EC2::SecurityGroup  identifier=sg-0abc123def
 *   type=AWS::ElasticLoadBalancingV2::LoadBalancer  identifier=arn:aws:elasticloadbalancing:...
 */
export async function aws_get(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const typeName = params["type"]?.trim();
  const identifier = params["identifier"]?.trim();
  if (!typeName)   return "ERROR: type param is required";
  if (!identifier) return "ERROR: identifier param is required";
  // Guard against the LLM passing a non-specific identifier like "all" or "*"
  if (/^(all|\*|list|any)$/i.test(identifier)) {
    return `ERROR: "${identifier}" is not a valid identifier. Use aws_query first to list resources and get their IDs, then call aws_get with a specific ID (e.g. i-0abc123, sg-0abc123, arn:...).`;
  }

  const r = params["region"]?.trim() || ctx.awsRegion;
  const client = new CloudControlClient({ region: r, ...(ctx.awsCredentials && { credentials: ctx.awsCredentials }) });

  try {
    const res = await client.send(
      new GetResourceCommand({ TypeName: typeName, Identifier: identifier }),
    );

    const props = res.ResourceDescription?.Properties;
    if (!props) return `No properties returned for ${typeName}/${identifier}`;

    // Pretty-print so the LLM can read nested objects
    try {
      return `${typeName}/${identifier}:\n${JSON.stringify(JSON.parse(props), null, 2).slice(0, 3_000)}`;
    } catch {
      return `${typeName}/${identifier}:\n${props.slice(0, 3_000)}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not supported") || msg.includes("UnsupportedAction")) {
      return `Cloud Control does not support ${typeName}. Try aws_query with a related CloudFormation type, or aws_get with a known identifier.`;
    }
    return `ERROR: ${msg}`;
  }
}

// ─── Tool 4: cw_metrics ───────────────────────────────────────────────────────

/**
 * Fetch CloudWatch metric statistics for any AWS resource.
 * Uses @aws-sdk/client-cloudwatch — no CLI needed.
 *
 * namespace  e.g. AWS/EC2, AWS/RDS, AWS/ECS, AWS/Lambda, AWS/ApplicationELB
 * metric     e.g. CPUUtilization, NetworkIn, DatabaseConnections, Errors
 * dimensions e.g. InstanceId=i-0abc123  or  FunctionName=my-fn,Resource=my-fn
 */
export async function cw_metrics(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const namespace  = params["namespace"]?.trim();
  const metric     = params["metric"]?.trim();
  // LLM may pass dimensions as an object {"InstanceId":"i-0abc"} — normalise to "Key=Value" string
  const rawDims = params["dimensions"];
  const dimensions = rawDims == null
    ? undefined
    : typeof rawDims === "object"
      ? Object.entries(rawDims as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(",")
      : String(rawDims).trim();
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
    const client = new CloudWatchClient({ region: r, ...(ctx.awsCredentials && { credentials: ctx.awsCredentials }) });
    const res = await client.send(new GetMetricStatisticsCommand({
      Namespace:  namespace,
      MetricName: metric,
      Dimensions: dims,
      StartTime,
      EndTime,
      Period:     periodMin * 60,
      Statistics: [stat],
      Unit:       StandardUnit.Percent,   // falls back gracefully if unit doesn't match
    }));

    const points = (res.Datapoints ?? [])
      .sort((a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0));

    if (points.length === 0) {
      return `No datapoints for ${namespace}/${metric} (dims=${dimensions ?? "none"}) last ${sinceHours}h in ${r}`;
    }

    const rows = points.map((p) => {
      const ts  = p.Timestamp?.toISOString().slice(11, 19) ?? "?";
      const val = (p[stat as keyof typeof p] as number | undefined)?.toFixed(2) ?? "?";
      return `${ts}  ${val}`;
    });

    const values = points.map((p) => (p[stat as keyof typeof p] as number | undefined) ?? 0);
    const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
    const max = Math.max(...values).toFixed(2);

    return [
      `${namespace}/${metric}  dims=${dimensions ?? "none"}  last ${sinceHours}h  period=${periodMin}m  stat=${stat}`,
      `avg=${avg}  max=${max}  points=${points.length}`,
      ...rows,
    ].join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 5: cw_logs ─────────────────────────────────────────────────────────

/**
 * Search CloudWatch Logs using @aws-sdk/client-cloudwatch-logs — no CLI needed.
 * log_group can be a full name or a prefix (uses DescribeLogGroups to discover).
 */
export async function cw_logs(
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  const logGroupParam   = params["log_group"]?.trim();
  const filterPattern   = params["filter_pattern"]?.trim() ?? "";
  const sinceHours      = parseFloat(params["since_hours"] ?? "1");
  const limit           = Math.min(parseInt(params["limit"] ?? "30", 10), 50);
  const r               = params["region"]?.trim() || ctx.awsRegion;

  if (!logGroupParam) return "ERROR: log_group param required";

  const client    = new CloudWatchLogsClient({ region: r, ...(ctx.awsCredentials && { credentials: ctx.awsCredentials }) });
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
      return `${ts}${lvl ? "  " + lvl : ""}  ${msg}`;
    });

    return [`log_group=${logGroupName}  filter="${filterPattern}"  last ${sinceHours}h  (${events.length} events)`, ...lines].join("\n");
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Tool 6: ec2_exec ─────────────────────────────────────────────────────────

/**
 * Run a shell command ON an EC2 instance via AWS Systems Manager (SSM).
 * No SSH key, no open port 22 needed — instance just needs the SSM agent running.
 *
 * Use this when you need to inspect something from INSIDE the instance:
 *   netstat -tlnp, curl <internal-endpoint>, cat /var/log/app.log, df -h, etc.
 */
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

  // Escape single-quotes inside the command so it's safe inside a JSON array string.
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Send the command via SSM.
  const sendRaw = await shell(
    `aws ssm send-command` +
    ` --instance-ids "${instanceId}"` +
    ` --document-name "AWS-RunShellScript"` +
    ` --parameters '{"commands":["${escaped}"]}'` +
    ` --region ${r}` +
    ` --output json`,
    15_000,
  );

  let commandId: string;
  try {
    const data = JSON.parse(sendRaw) as { Command?: { CommandId?: string } };
    commandId = data.Command?.CommandId ?? "";
    if (!commandId) return `ERROR: no CommandId in SSM response — ${sendRaw.slice(0, 300)}`;
  } catch {
    return `ERROR sending SSM command: ${sendRaw.slice(0, 300)}`;
  }

  // Poll GetCommandInvocation until terminal state (max ~45 s).
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise<void>((res) => setTimeout(res, 3_000));

    const pollRaw = await shell(
      `aws ssm get-command-invocation` +
      ` --command-id "${commandId}"` +
      ` --instance-id "${instanceId}"` +
      ` --region ${r}` +
      ` --output json`,
      10_000,
    );

    try {
      const inv = JSON.parse(pollRaw) as {
        Status?: string;
        StandardOutputContent?: string;
        StandardErrorContent?: string;
        StatusDetails?: string;
      };

      const status = inv.Status ?? "";
      if (status === "Success" || status === "Failed" || status === "Cancelled" || status === "TimedOut") {
        const stdout = (inv.StandardOutputContent ?? "").trim();
        const stderr = (inv.StandardErrorContent  ?? "").trim();
        const lines: string[] = [`EC2_EXEC status=${status} instance=${instanceId} cmd="${command}"`];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`STDERR: ${stderr}`);
        return lines.join("\n").slice(0, 3_000);
      }
      // InProgress / Pending — keep polling
    } catch {
      // pollRaw might not be JSON yet (e.g. invocation not registered) — keep trying
    }
  }

  return `TIMEOUT: SSM command "${commandId}" did not complete within 45 s on ${instanceId}`;
}

// ─── Tool catalog (shown to LLM in every prompt) ─────────────────────────────

export function buildToolCatalog(): string {
  return `TOOLS:

1. run_command(command: string)
   Execute any read-only shell command. k8s context auto-injected for kubectl/helm.
   Use for: kubectl, helm, dig, nslookup, curl, nc, ping, openssl, ssh, traceroute.
   Do NOT use for AWS — use the SDK tools below instead.

2. aws_query(type: string, region?: string, max_results?: string, filter?: string)
   List AWS resources by CloudFormation type via Cloud Control SDK (no CLI needed).
   filter: optional JSON ResourceModel string to scope results, e.g. '{"VpcId":"vpc-0abc"}'.

3. aws_get(type: string, identifier: string, region?: string)
   Fetch full properties of one AWS resource via Cloud Control SDK. identifier must be a real resource ID from aws_query.

4. ec2_exec(instance_id: string, command: string, region?: string)
   Run a command inside an EC2 instance via SSM (no SSH key needed).

5. cw_metrics(namespace: string, metric: string, dimensions?: string, since_hours?: string, period_minutes?: string, statistic?: string, region?: string)
   Fetch CloudWatch metric statistics. dimensions format: "Key=Value" or "Key1=V1,Key2=V2".

6. cw_logs(log_group: string, filter_pattern?: string, since_hours?: string, limit?: string, region?: string)
   Search CloudWatch Logs. log_group can be a full name or prefix.`;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  params: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "run_command": return run_command(params, ctx);
    case "aws_query":   return aws_query(params, ctx);
    case "aws_get":     return aws_get(params, ctx);
    case "ec2_exec":    return ec2_exec(params, ctx);
    case "cw_metrics":  return cw_metrics(params, ctx);
    case "cw_logs":     return cw_logs(params, ctx);
    default:
      return `ERROR: Unknown tool "${name}". Available: run_command, aws_query, aws_get, ec2_exec, cw_metrics, cw_logs`;
  }
}
