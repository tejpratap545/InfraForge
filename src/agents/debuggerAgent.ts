import { BedrockService } from "../services/bedrockService";
import { DebugAggregator } from "../providers/debugAggregator";
import { DebugSignal, DebugOptions } from "../types";
import { c, sym } from "../utils/terminal";

const SEVERITY_ICON: Record<string, string> = {
  critical: c.bold(c.red("[CRIT ]")),
  error:    c.red("[ERROR]"),
  warn:     c.yellow("[WARN ]"),
  info:     c.dim("[INFO ]"),
};

const SOURCE_LABEL: Record<string, string> = {
  "cloudwatch-logs":    "CW-LOGS    ",
  "cloudwatch-metrics": "CW-METRICS ",
  "opensearch":         "OPENSEARCH ",
  "loki":               "LOKI       ",
  "k8s-pod-logs":       "K8S-LOGS   ",
  "k8s-events":         "K8S-EVENTS ",
};

function formatSignal(s: DebugSignal): string {
  const icon   = SEVERITY_ICON[s.severity ?? "info"] ?? c.dim("[INFO ]");
  const source = c.dim((SOURCE_LABEL[s.source] ?? s.source).padEnd(11));
  const ts     = s.timestamp ? c.dim(` ${s.timestamp}`) : "";
  const res    = s.resourceName ? c.dim(` (${s.resourceName})`) : "";
  return `  ${icon} ${source}${ts}${res}  ${s.payload}`;
}

export class DebuggerAgent {
  constructor(
    private readonly aggregator: DebugAggregator,
    private readonly bedrock: BedrockService,
  ) {}

  async analyze(serviceName: string, options: DebugOptions): Promise<string> {
    const result = await this.aggregator.collect(serviceName, options);

    // Coverage header lines (returned as plain text for the workflow to print).
    const coverageLines: string[] = [];
    if (result.contributors.length > 0)
      coverageLines.push(`    ${c.green(sym.check)} ${c.bold("With data ".padEnd(16))}  ${result.contributors.join("  ·  ")}`);
    if (result.emptyProviders.length > 0)
      coverageLines.push(`    ${c.dim(sym.circle)} ${c.dim("No data".padEnd(16))}  ${c.dim(result.emptyProviders.join(", "))}`);
    if (result.skippedProviders.length > 0)
      coverageLines.push(`    ${c.dim(sym.circle)} ${c.dim("Skipped".padEnd(16))}  ${c.dim(result.skippedProviders.join(", "))}`);

    if (result.signals.length === 0) {
      return [
        ...coverageLines,
        "",
        `  ${c.yellow(sym.warn)}  No signals found for ${c.bold(serviceName)} in the last ${options.since ?? "1h"}.`,
        "",
        `  ${c.dim("Suggestions:")}`,
        `  ${c.dim(sym.arrow)} Verify the service name matches k8s labels / log group names.`,
        `  ${c.dim(sym.arrow)} Pass ${c.dim("--namespace")} if the service is not in the default namespace.`,
        `  ${c.dim(sym.arrow)} Pass ${c.dim("--loki-url")} or ${c.dim("--opensearch-url")} for those backends.`,
        `  ${c.dim(sym.arrow)} Ensure AWS credentials are set for CloudWatch access.`,
      ].join("\n");
    }

    // Render signals block (plain text for the LLM prompt — no ANSI).
    const signals = result.signals.slice(0, 150);
    const signalBlockForLlm = signals
      .map((s) => {
        const icon   = `[${(s.severity ?? "info").toUpperCase().padEnd(6)}]`;
        const source = `[${s.source.padEnd(18)}]`;
        const ts     = s.timestamp ? ` ${s.timestamp}` : "";
        const res    = s.resourceName ? ` (${s.resourceName})` : "";
        return `${icon} ${source}${ts}${res} ${s.payload}`;
      })
      .join("\n");

    const prompt = [
      "You are a senior Site Reliability Engineer (SRE) performing incident triage.",
      "Analyze the provided observability signals and produce a structured root cause analysis report.",
      "Be specific, actionable, and concise. Prioritise immediate customer impact above all else.",
      "",
      `SERVICE       : ${serviceName}`,
      `ANALYSIS TIME : ${new Date().toISOString()}`,
      `LOOK-BACK     : ${options.since ?? "1h"}`,
      `SIGNAL COUNT  : ${signals.length} (${result.contributors.join(", ")})`,
      "",
      "SEVERITY LEGEND: [CRIT  ]=critical  [ERROR ]=error  [WARN  ]=warning  [INFO  ]=informational",
      "SOURCE LEGEND  : CW-LOGS=CloudWatch Logs  CW-METRICS=CloudWatch Metrics",
      "                 LOKI=Grafana Loki  OPENSEARCH=OpenSearch/Elasticsearch",
      "                 K8S-POD-LOGS=Kubernetes pod logs  K8S-EVENTS=Kubernetes events",
      "",
      "OBSERVABILITY SIGNALS (sorted by severity desc, then timestamp desc):",
      "─".repeat(70),
      signalBlockForLlm,
      "─".repeat(70),
      "",
      "Respond ONLY in this exact format. Do not add extra sections.",
      "",
      "## Root Cause Analysis",
      "",
      "**Probable Root Cause:** [one clear sentence] (Confidence: HIGH | MEDIUM | LOW)",
      "",
      "**Supporting Evidence:**",
      "- [signal/observation and what it indicates]",
      "- [signal/observation and what it indicates]",
      "",
      "## Immediate Mitigations (< 30 min)",
      "1. [Specific kubectl / AWS CLI action] — [Expected outcome]",
      "2. [Specific action] — [Expected outcome]",
      "",
      "## Short-term Fixes (< 24 hours)",
      "1. [Action] — [Expected outcome]",
      "",
      "## Long-term Remediation (1–4 weeks)",
      "1. [Architectural or process change and why it prevents recurrence]",
      "",
      "## Impact Assessment",
      "- **Blast radius:** [scope]",
      "- **Estimated MTTR:** [time estimate with rationale]",
      "- **Recurrence risk:** HIGH | MEDIUM | LOW — [one-line reason]",
      "",
      "## Recommended Observability Improvements",
      "- [Alert or dashboard gap identified from the signal set]",
    ].join("\n");

    const analysis = await this.bedrock.complete(prompt);

    // Pretty-print the signals section for terminal display.
    const renderedSignals = [
      "",
      `  ${c.bold(c.dim("Signals"))}  ${c.dim(`(${signals.length} total · sorted by severity)`)}\n`,
      ...signals.slice(0, 30).map(formatSignal),
      signals.length > 30 ? c.dim(`  … and ${signals.length - 30} more signals fed to the LLM`) : "",
    ]
      .filter(Boolean)
      .join("\n");

    return [...coverageLines, renderedSignals, "", analysis].join("\n");
  }
}
