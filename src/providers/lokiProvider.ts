import { IDebugProvider } from "./IDebugProvider";
import { DebugSignal, DebugOptions, DebugSeverity } from "../types";

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][]; // [nanosecond-timestamp, log-line]
}

interface LokiQueryRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
  };
}

function parseSinceNs(since: string): string {
  const m = since.match(/^(\d+)(m|h|d)$/);
  if (!m) return String((Date.now() - 3_600_000) * 1_000_000);
  const factor: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return String((Date.now() - parseInt(m[1]) * (factor[m[2]] ?? 3_600_000)) * 1_000_000);
}

function detectSeverity(msg: string): DebugSeverity {
  const lower = msg.toLowerCase();
  if (/panic|fatal|critical|oomkilled/.test(lower)) return "critical";
  if (/error|exception|failed|failure/.test(lower)) return "error";
  if (/warn|warning|slow|timeout|throttl/.test(lower)) return "warn";
  return "info";
}

async function lokiFetch(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`Loki HTTP ${resp.status}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export class LokiProvider implements IDebugProvider {
  readonly name = "Loki";

  async isAvailable(options: DebugOptions): Promise<boolean> {
    if (!options.lokiUrl) return false;
    try {
      await lokiFetch(`${options.lokiUrl}/ready`, 4000);
      return true;
    } catch {
      return false;
    }
  }

  async fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]> {
    if (!options.lokiUrl) return [];
    try {
      const startNs = parseSinceNs(options.since ?? "1h");
      const endNs = String(Date.now() * 1_000_000);
      const limit = options.tailLines ?? 100;

      // Try multiple common label selectors — fail silently if none match.
      const queries = [
        `{app="${serviceName}"}`,
        `{service="${serviceName}"}`,
        `{job="${serviceName}"}`,
        `{container="${serviceName}"}`,
        `{namespace="${options.namespace ?? "default"}",app="${serviceName}"}`,
      ];

      const signals: DebugSignal[] = [];

      for (const q of queries) {
        try {
          const url =
            `${options.lokiUrl}/loki/api/v1/query_range` +
            `?query=${encodeURIComponent(q + ' |~ "(?i)(error|warn|fail|exception|panic|oom|timeout|throttl|fatal)"')}` +
            `&start=${startNs}&end=${endNs}&limit=${limit}&direction=backward`;

          const body = (await lokiFetch(url)) as LokiQueryRangeResponse;
          if (body.status !== "success" || body.data.result.length === 0) continue;

          for (const stream of body.data.result) {
            for (const [tsNs, line] of stream.values) {
              const tsMs = Math.floor(parseInt(tsNs) / 1_000_000);
              signals.push({
                source: "loki",
                severity: detectSeverity(line),
                timestamp: new Date(tsMs).toISOString(),
                resourceName: stream.stream.pod ?? stream.stream.container ?? stream.stream.app ?? serviceName,
                payload: line.trim(),
              });
            }
          }

          if (signals.length > 0) break; // Found results — stop trying other selectors.
        } catch {
          // Try next selector.
        }
      }

      return signals.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "")).slice(0, limit);
    } catch {
      return [];
    }
  }
}
