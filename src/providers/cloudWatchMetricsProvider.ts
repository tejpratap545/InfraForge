import { CloudWatchService, METRIC_PROFILES } from "../services/cloudWatchService";
import { IDebugProvider } from "./IDebugProvider";
import { DebugSignal, DebugOptions } from "../types";

const cw = new CloudWatchService();

// Thresholds for surfacing a metric as a debug signal.
const THRESHOLDS: Record<string, { warn?: number; error?: number }> = {
  CPUUtilization:              { warn: 70,   error: 90 },
  MemoryUtilization:           { warn: 75,   error: 90 },
  Errors:                      { warn: 1,    error: 10 },
  Throttles:                   { warn: 1 },
  "HTTPCode_Target_5XX_Count": { warn: 1,    error: 50 },
  TargetResponseTime:          { warn: 1,    error: 5 },
  pod_cpu_utilization:         { warn: 70,   error: 90 },
  pod_memory_utilization:      { warn: 75,   error: 90 },
};

export class CloudWatchMetricsProvider implements IDebugProvider {
  readonly name = "CloudWatch Metrics";

  async isAvailable(options: DebugOptions): Promise<boolean> {
    return cw.pingMetrics(options.awsRegion ?? "us-east-1");
  }

  async fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]> {
    const region = options.awsRegion ?? "us-east-1";
    const periodHours = options.since
      ? (options.since.endsWith("h") ? parseInt(options.since) : options.since.endsWith("d") ? parseInt(options.since) * 24 : 1)
      : 1;

    // Query all profiles for the service name as the dimension value.
    const queries = Object.values(METRIC_PROFILES).flatMap((p) =>
      p.metrics.map((metricName) => ({
        namespace:      p.namespace,
        dimensionName:  p.dimensionName,
        dimensionValue: serviceName,
        metricName,
      })),
    );

    const results = await cw.queryMetrics(queries, periodHours, region);

    return results
      .filter((r) => {
        const t = THRESHOLDS[r.metricName];
        return t != null; // only surface metrics that have thresholds defined
      })
      .map((r) => {
        const t = THRESHOLDS[r.metricName] ?? {};
        const severity: DebugSignal["severity"] =
          t.error != null && r.value >= t.error ? "error" :
          t.warn  != null && r.value >= t.warn  ? "warn"  : "info";
        return {
          source:       "cloudwatch-metrics" as const,
          severity,
          resourceName: `${r.namespace}/${r.metricName}`,
          payload:      `${r.namespace} ${r.metricName} [${r.stat}=${r.value.toFixed(2)}]`,
        };
      })
      .filter((s) => s.severity !== "info")
      .sort((a, b) => (b.severity ?? "").localeCompare(a.severity ?? ""));
  }
}
