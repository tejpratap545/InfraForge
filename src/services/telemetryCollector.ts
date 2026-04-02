/** Per-run telemetry: LLM call counts, token usage, latency, cost estimate. */

export interface LLMCallRecord {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  startedAt: number; // epoch ms
}

/** Approximate Bedrock on-demand pricing (USD per 1M tokens, as of 2025). */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet": { in: 3.0,  out: 15.0  },
  "claude-opus":   { in: 15.0, out: 75.0  },
  "claude-haiku":  { in: 0.8,  out: 4.0   },
  "mistral":       { in: 2.0,  out: 6.0   },
  "default":       { in: 3.0,  out: 15.0  },
};

function priceKey(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes("opus"))   return "claude-opus";
  if (id.includes("haiku"))  return "claude-haiku";
  if (id.includes("sonnet")) return "claude-sonnet";
  if (id.includes("mistral"))return "mistral";
  return "default";
}

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[priceKey(modelId)] ?? PRICING["default"]!;
  return (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

export function pricing(modelId: string): { in: number; out: number } {
  return PRICING[priceKey(modelId)] ?? PRICING["default"]!;
}

export class TelemetryCollector {
  readonly runId: string;
  readonly startedAt: number;
  private readonly records: LLMCallRecord[] = [];

  constructor(runId: string) {
    this.runId = runId;
    this.startedAt = Date.now();
  }

  record(rec: LLMCallRecord): void {
    this.records.push(rec);
  }

  get calls(): readonly LLMCallRecord[] { return this.records; }
  get callCount(): number { return this.records.length; }

  get totalInputTokens(): number {
    return this.records.reduce((n, r) => n + r.inputTokens, 0);
  }

  get totalOutputTokens(): number {
    return this.records.reduce((n, r) => n + r.outputTokens, 0);
  }

  get totalTokens(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Best-effort model ID inferred from the first recorded call. */
  get primaryModelId(): string {
    return this.records[0]?.modelId ?? "unknown";
  }

  totalCost(): number {
    return this.records.reduce(
      (sum, r) => sum + estimateCost(r.modelId, r.inputTokens, r.outputTokens),
      0,
    );
  }
}
