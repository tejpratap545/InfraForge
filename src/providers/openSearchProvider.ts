import { IDebugProvider } from "./IDebugProvider";
import { DebugSignal, DebugOptions, DebugSeverity } from "../types";

interface OsHit {
  _index: string;
  _source: Record<string, unknown>;
}

interface OsSearchResponse {
  hits: {
    hits: OsHit[];
  };
}

function parseSinceIso(since: string): string {
  const m = since.match(/^(\d+)(m|h|d)$/);
  if (!m) return new Date(Date.now() - 3_600_000).toISOString();
  const factor: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - parseInt(m[1]) * (factor[m[2]] ?? 3_600_000)).toISOString();
}

function detectSeverity(level: string | undefined, msg: string): DebugSeverity {
  const l = (level ?? "").toLowerCase();
  if (/critical|fatal|panic/.test(l) || /panic|fatal|oomkilled/.test(msg.toLowerCase())) return "critical";
  if (/error/.test(l) || /error|exception|failed/.test(msg.toLowerCase())) return "error";
  if (/warn/.test(l) || /warn|timeout|throttl/.test(msg.toLowerCase())) return "warn";
  return "info";
}

function extractMessage(source: Record<string, unknown>): string {
  return String(
    source["message"] ?? source["msg"] ?? source["log"] ?? source["@message"] ?? JSON.stringify(source).slice(0, 300),
  );
}

function extractTimestamp(source: Record<string, unknown>): string | undefined {
  const raw = source["@timestamp"] ?? source["timestamp"] ?? source["time"];
  return raw ? String(raw) : undefined;
}

function extractLevel(source: Record<string, unknown>): string | undefined {
  return String(source["level"] ?? source["severity"] ?? source["log.level"] ?? "");
}

async function osFetch(url: string, body: unknown, auth?: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (auth) headers["Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`OpenSearch HTTP ${resp.status}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export class OpenSearchProvider implements IDebugProvider {
  readonly name = "OpenSearch";

  async isAvailable(options: DebugOptions): Promise<boolean> {
    if (!options.openSearchUrl) return false;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 4000);
      const auth = options.openSearchUser
        ? `${options.openSearchUser}:${options.openSearchPass ?? ""}`
        : undefined;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (auth) headers["Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
      const resp = await fetch(`${options.openSearchUrl}/_cluster/health`, {
        headers,
        signal: controller.signal,
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]> {
    if (!options.openSearchUrl) return [];
    try {
      const index = options.openSearchIndex ?? "*";
      const since = parseSinceIso(options.since ?? "1h");
      const limit = options.tailLines ?? 100;
      const auth = options.openSearchUser
        ? `${options.openSearchUser}:${options.openSearchPass ?? ""}`
        : undefined;

      const query = {
        size: limit,
        sort: [{ "@timestamp": { order: "desc" } }],
        query: {
          bool: {
            filter: [
              { range: { "@timestamp": { gte: since } } },
              {
                bool: {
                  should: [
                    { match: { "kubernetes.labels.app": serviceName } },
                    { match: { "service.name": serviceName } },
                    { match: { "app": serviceName } },
                    { wildcard: { "log": `*${serviceName}*` } },
                  ],
                  minimum_should_match: 1,
                },
              },
            ],
            should: [
              { match: { level: "error" } },
              { match: { level: "warn" } },
              { match: { severity: "ERROR" } },
              { match: { message: "error" } },
              { match: { message: "exception" } },
              { match: { message: "failed" } },
              { match: { message: "timeout" } },
            ],
            minimum_should_match: 0,
          },
        },
      };

      const url = `${options.openSearchUrl}/${index}/_search`;
      const body = (await osFetch(url, query, auth)) as OsSearchResponse;
      const signals: DebugSignal[] = [];

      for (const hit of body.hits?.hits ?? []) {
        const src = hit._source;
        const msg = extractMessage(src);
        const level = extractLevel(src);
        signals.push({
          source: "opensearch",
          severity: detectSeverity(level, msg),
          timestamp: extractTimestamp(src),
          resourceName: hit._index,
          payload: msg,
        });
      }

      return signals;
    } catch {
      return [];
    }
  }
}
