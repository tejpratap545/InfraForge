import { IDebugProvider } from "./IDebugProvider";
import { CloudWatchLogsProvider } from "./cloudWatchLogsProvider";
import { CloudWatchMetricsProvider } from "./cloudWatchMetricsProvider";
import { LokiProvider } from "./lokiProvider";
import { OpenSearchProvider } from "./openSearchProvider";
import { K8sProvider } from "./k8sProvider";
import { DebugSignal, DebugOptions } from "../types";

export interface AggregationResult {
  signals: DebugSignal[];
  /** Which providers successfully contributed signals. */
  contributors: string[];
  /** Providers that were configured but returned no data. */
  emptyProviders: string[];
  /** Providers that were skipped (not available / not configured). */
  skippedProviders: string[];
}

export class DebugAggregator {
  private readonly providers: IDebugProvider[];

  constructor(providers?: IDebugProvider[]) {
    this.providers = providers ?? [
      new CloudWatchLogsProvider(),
      new CloudWatchMetricsProvider(),
      new LokiProvider(),
      new OpenSearchProvider(),
      new K8sProvider(),
    ];
  }

  async collect(serviceName: string, options: DebugOptions): Promise<AggregationResult> {
    // Check availability of all providers in parallel.
    const availability = await Promise.all(
      this.providers.map((p) => p.isAvailable(options).catch(() => false)),
    );

    const available = this.providers.filter((_, i) => availability[i]);
    const skippedProviders = this.providers.filter((_, i) => !availability[i]).map((p) => p.name);

    if (available.length === 0) {
      return { signals: [], contributors: [], emptyProviders: [], skippedProviders };
    }

    // Fetch from all available providers in parallel.
    const results = await Promise.allSettled(
      available.map((p) => p.fetchSignals(serviceName, options)),
    );

    const contributors: string[] = [];
    const emptyProviders: string[] = [];
    const allSignals: DebugSignal[] = [];

    for (let i = 0; i < available.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled" && result.value.length > 0) {
        contributors.push(available[i].name);
        allSignals.push(...result.value);
      } else {
        emptyProviders.push(available[i].name);
      }
    }

    // Sort by severity first (critical → error → warn → info), then timestamp desc.
    const severityOrder: Record<string, number> = { critical: 0, error: 1, warn: 2, info: 3 };
    const sorted = allSignals.sort((a, b) => {
      const sd = (severityOrder[a.severity ?? "info"] ?? 3) - (severityOrder[b.severity ?? "info"] ?? 3);
      if (sd !== 0) return sd;
      return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
    });

    return { signals: sorted, contributors, emptyProviders, skippedProviders };
  }
}
