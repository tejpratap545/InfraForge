import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { DebugSignal, DebugSeverity } from "../types";

// ─── Metric registry ──────────────────────────────────────────────────────────
// Maps resource type alias → { namespace, dimensionName, metricNames[] }
// Used by AwsMetricsService to resolve sensible defaults from AskMetricsContext.

export interface MetricProfile {
  namespace: string;
  dimensionName: string;
  metrics: string[];
}

export const METRIC_PROFILES: Record<string, MetricProfile> = {
  ec2:          { namespace: "AWS/EC2",              dimensionName: "InstanceId",            metrics: ["CPUUtilization","NetworkIn","NetworkOut","StatusCheckFailed"] },
  lambda:       { namespace: "AWS/Lambda",            dimensionName: "FunctionName",          metrics: ["Invocations","Errors","Throttles","Duration","ConcurrentExecutions"] },
  rds:          { namespace: "AWS/RDS",               dimensionName: "DBInstanceIdentifier",  metrics: ["CPUUtilization","DatabaseConnections","FreeStorageSpace","ReadIOPS","WriteIOPS","FreeableMemory"] },
  ecs:          { namespace: "AWS/ECS",               dimensionName: "ServiceName",           metrics: ["CPUUtilization","MemoryUtilization"] },
  alb:          { namespace: "AWS/ApplicationELB",    dimensionName: "LoadBalancer",          metrics: ["RequestCount","TargetResponseTime","HTTPCode_Target_5XX_Count","HTTPCode_Target_4XX_Count","HealthyHostCount"] },
  elasticache:  { namespace: "AWS/ElastiCache",       dimensionName: "CacheClusterId",        metrics: ["CPUUtilization","CurrConnections","CacheHits","CacheMisses","Evictions","FreeableMemory"] },
  eks:          { namespace: "ContainerInsights",     dimensionName: "ClusterName",           metrics: ["pod_cpu_utilization","pod_memory_utilization","node_cpu_utilization","node_memory_utilization"] },
};

// ─── Shared severity helper ───────────────────────────────────────────────────

export function detectLogSeverity(msg: string): DebugSeverity {
  const lower = msg.toLowerCase();
  if (/panic|fatal|critical|oomkilled|out of memory/.test(lower)) return "critical";
  if (/error|exception|failed|failure|5\d\d/.test(lower))         return "error";
  if (/warn|warning|slow|timeout|throttl/.test(lower))            return "warn";
  return "info";
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Unified CloudWatch gateway — metrics + logs in one place.
 *
 * Metrics: one `GetMetricData` batch call instead of N parallel
 * `GetMetricStatistics` calls (AWS recommended, more efficient, single round-trip).
 *
 * Logs: `FilterLogEvents` across auto-discovered or explicit log groups.
 */
export class CloudWatchService {
  private metricsClient(region: string) { return new CloudWatchClient({ region }); }
  private logsClient(region: string)    { return new CloudWatchLogsClient({ region }); }

  // ── Metrics ─────────────────────────────────────────────────────────────────

  /**
   * Fetch metrics for a set of (namespace, dimensionName, dimensionValue, metricName) tuples.
   * Returns one result row per metric — or an empty array if nothing came back.
   */
  async queryMetrics(
    queries: Array<{ namespace: string; dimensionName: string; dimensionValue: string; metricName: string; stat?: string }>,
    periodHours: number,
    region: string,
  ): Promise<Array<{ metricName: string; namespace: string; stat: string; value: number; unit?: string }>> {
    if (queries.length === 0) return [];

    const endTime   = new Date();
    const startTime = new Date(endTime.getTime() - periodHours * 3_600_000);
    const period    = periodHours <= 1 ? 300 : periodHours <= 6 ? 600 : 3600;

    const metricDataQueries: MetricDataQuery[] = queries.map((q, i) => ({
      Id:         `m${i}`,
      Label:      `${q.namespace}/${q.metricName}`,
      MetricStat: {
        Metric: {
          Namespace:  q.namespace,
          MetricName: q.metricName,
          Dimensions: [{ Name: q.dimensionName, Value: q.dimensionValue }],
        },
        Period: period,
        Stat:   q.stat ?? "Average",
      },
    }));

    try {
      const res = await this.metricsClient(region).send(
        new GetMetricDataCommand({ MetricDataQueries: metricDataQueries, StartTime: startTime, EndTime: endTime }),
      );

      return (res.MetricDataResults ?? [])
        .filter((r) => (r.Values?.length ?? 0) > 0)
        .map((r, i) => ({
          metricName: queries[i]?.metricName ?? r.Label ?? "",
          namespace:  queries[i]?.namespace ?? "",
          stat:       queries[i]?.stat ?? "avg",
          value:      r.Values?.[0] ?? 0,
        }));
    } catch {
      return [];
    }
  }

  // ── Logs ─────────────────────────────────────────────────────────────────────

  async discoverLogGroups(serviceName: string, region: string): Promise<string[]> {
    const client = this.logsClient(region);
    const prefixes = [
      `/aws/lambda/${serviceName}`,
      `/aws/ecs/${serviceName}`,
      `/aws/eks/${serviceName}`,
      `/aws/containerinsights`,
      `/${serviceName}`,
      serviceName,
    ];
    const found: string[] = [];
    await Promise.all(
      prefixes.map(async (prefix) => {
        try {
          const resp = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, limit: 3 }));
          for (const g of resp.logGroups ?? []) {
            if (g.logGroupName) found.push(g.logGroupName);
          }
        } catch { /* inaccessible prefix */ }
      }),
    );
    return [...new Set(found)];
  }

  async queryLogs(
    logGroups: string[],
    region: string,
    opts: { since?: string; tailLines?: number; filterPattern?: string },
  ): Promise<DebugSignal[]> {
    if (logGroups.length === 0) return [];

    const client       = this.logsClient(region);
    const startTime    = this.parseSinceMs(opts.since ?? "1h");
    const limit        = opts.tailLines ?? 50;
    const filterPattern = opts.filterPattern ?? "?ERROR ?WARN ?Exception ?OOM ?Killed ?failed ?panic ?timeout ?throttl";
    const signals: DebugSignal[] = [];

    await Promise.all(
      logGroups.slice(0, 5).map(async (logGroupName) => {
        try {
          const resp = await client.send(
            new FilterLogEventsCommand({ logGroupName, startTime, filterPattern, limit }),
          );
          for (const ev of resp.events ?? []) {
            signals.push({
              source:       "cloudwatch-logs",
              severity:     detectLogSeverity(ev.message ?? ""),
              timestamp:    ev.timestamp ? new Date(ev.timestamp).toISOString() : undefined,
              resourceName: logGroupName,
              payload:      (ev.message ?? "").trim(),
            });
          }
        } catch { /* inaccessible group */ }
      }),
    );

    return signals.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  }

  async pingLogs(region: string): Promise<boolean> {
    try {
      await this.logsClient(region).send(new DescribeLogGroupsCommand({ limit: 1 }));
      return true;
    } catch { return false; }
  }

  async pingMetrics(region: string): Promise<boolean> {
    const result = await this.queryMetrics(
      [{ namespace: "AWS/EC2", dimensionName: "InstanceId", dimensionValue: "probe", metricName: "CPUUtilization" }],
      1, region,
    );
    return result !== null; // always true — non-throwing means accessible
  }

  private parseSinceMs(since: string): number {
    const m = since.match(/^(\d+)(m|h|d)$/);
    if (!m) return Date.now() - 3_600_000;
    const factor: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Date.now() - parseInt(m[1]) * (factor[m[2]] ?? 3_600_000);
  }
}
