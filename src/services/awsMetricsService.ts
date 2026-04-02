import { AskMetricsContext } from "../types";
import { CloudWatchService, METRIC_PROFILES } from "./cloudWatchService";

const cw = new CloudWatchService();

export class AwsMetricsService {
  async query(ctx: AskMetricsContext, region: string): Promise<string> {
    const profile = METRIC_PROFILES[ctx.resourceType.toLowerCase()];
    if (!profile) return `No metric profile for resource type '${ctx.resourceType}'.`;

    const metricNames = ctx.metrics.length > 0 ? ctx.metrics : profile.metrics;

    const queries = metricNames.map((metricName) => ({
      namespace:      profile.namespace,
      dimensionName:  profile.dimensionName,
      dimensionValue: ctx.resourceId ?? "",
      metricName,
    }));

    const results = await cw.queryMetrics(queries, ctx.periodHours, region);

    if (results.length === 0) {
      return `No CloudWatch data for ${ctx.resourceType}${ctx.resourceId ? ` / ${ctx.resourceId}` : ""} in the last ${ctx.periodHours}h.`;
    }

    const lines = [
      `CloudWatch metrics for ${ctx.resourceType.toUpperCase()}${ctx.resourceId ? ` [${ctx.resourceId}]` : " (all)"}  — last ${ctx.periodHours}h:`,
      "",
      ...results.map((r) => `  ${r.metricName.padEnd(36)} ${r.stat}=${this.fmt(r.value)}`),
    ];
    return lines.join("\n");
  }

  private fmt(v: number): string {
    return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M`
         : v >= 1_000     ? `${(v / 1_000).toFixed(1)}K`
         :                  v.toFixed(2);
  }
}
