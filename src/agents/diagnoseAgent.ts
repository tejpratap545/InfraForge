import { BedrockService } from "../services/bedrockService";
import { DebugAggregator } from "../providers/debugAggregator";
import { K8sDependencyTracer, DependencyGraph } from "../services/k8sDependencyTracer";
import { K8sInventoryService } from "../services/k8sInventoryService";
import { AwsMetricsService } from "../services/awsMetricsService";
import { ServiceDiscovery } from "../services/serviceDiscovery";
import { parseJsonPayload } from "../utils/llm";
import {
  c,
  sym,
  Spinner,
  printBoxHeader,
  printKV,
  printFound,
  printSkipped,
  renderReport,
  urgencyBadge,
} from "../utils/terminal";
import { DiagnoseIntent, DebugOptions, AskMetricsContext, AskK8sQuery, DebugSignal } from "../types";

// ─── Intent parser ────────────────────────────────────────────────────────────

const PARSE_PROMPT = (question: string) => `You are an SRE assistant. Extract a JSON object from the user's infrastructure question.

{
  "serviceName": "<service/workload name as it appears in k8s labels or AWS resource names, lowercase>",
  "problem":     "<crashing | oom | pending | errors | latency | connectivity | scaling | unknown>",
  "lookBack":    "<30m | 1h | 6h | 24h — based on severity>",
  "urgency":     "<critical | high | medium | low>"
}

Rules:
- CrashLoopBackOff / OOMKilled / not starting → urgency=critical, lookBack=1h
- Latency / high error rate → urgency=high, lookBack=1h
- Intermittent → urgency=medium, lookBack=6h
- Keep serviceName short: "mimir" not "mimir-distributor-abc123"
- Sub-component: "mimir distributor" → "mimir-distributor"

Respond with JSON ONLY.

Question: "${question}"`;

// ─── Metrics selection per problem ───────────────────────────────────────────

function metricsForProblem(problem: string): AskMetricsContext {
  switch (problem) {
    case "oom":
      return { resourceType: "eks", metrics: ["pod_memory_utilization", "node_memory_utilization"], periodHours: 1 };
    case "latency":
      return { resourceType: "alb", metrics: ["TargetResponseTime", "RequestCount", "HTTPCode_Target_5XX_Count"], periodHours: 1 };
    case "errors":
      return { resourceType: "lambda", metrics: ["Errors", "Throttles", "Duration"], periodHours: 1 };
    case "scaling":
      return { resourceType: "ecs", metrics: ["CPUUtilization", "MemoryUtilization"], periodHours: 1 };
    case "crashing":
    default:
      return { resourceType: "eks", metrics: ["pod_cpu_utilization", "pod_memory_utilization", "node_cpu_utilization"], periodHours: 1 };
  }
}

// ─── Signal block formatter ───────────────────────────────────────────────────

function buildSignalBlock(signals: DebugSignal[]): string {
  if (signals.length === 0) return "(no signals found)";
  return signals
    .slice(0, 120)
    .map((s) =>
      `[${(s.severity ?? "info").toUpperCase().padEnd(8)}] [${s.source.padEnd(18)}] ${s.timestamp ?? ""} ` +
      `${s.resourceName ? `(${s.resourceName}) ` : ""}${s.payload}`,
    )
    .join("\n");
}

// ─── Dependency graph renderer ────────────────────────────────────────────────

function renderDependencyTree(graph: DependencyGraph): void {
  // Print each node indented by hop level.
  for (const node of graph.nodes) {
    const indent = "  ".repeat(node.hop);
    const connector = node.hop === 0 ? sym.tee : sym.corner;
    const label = node.hop === 0 ? c.bold(node.serviceName) : c.yellow(node.serviceName);
    const podLabel =
      node.pods.length > 0
        ? c.dim(`${node.pods.length} pod(s)`)
        : c.red("no pods");
    const roleTag = node.hop === 0 ? c.dim("[root]") : c.dim(`[dep hop=${node.hop}]`);
    process.stdout.write(
      `       ${c.dim(indent + connector)} ${label}  ${podLabel}  ${roleTag}\n`,
    );
  }
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class DiagnoseAgent {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly discovery: ServiceDiscovery,
    private readonly aggregator: DebugAggregator,
    private readonly k8sInventory: K8sInventoryService,
    private readonly awsMetrics: AwsMetricsService,
  ) {}

  async parseQuestion(question: string): Promise<DiagnoseIntent> {
    const raw = await this.bedrock.complete(PARSE_PROMPT(question));
    const parsed = parseJsonPayload(raw, "DiagnoseAgent intent parser") as Partial<DiagnoseIntent>;
    if (!parsed?.serviceName) {
      throw new Error(
        `Could not extract a service name from: "${question}". ` +
        `Try: "why is mimir crashing?" or "checkout-api is throwing 503s"`,
      );
    }
    return {
      serviceName: parsed.serviceName,
      problem: parsed.problem ?? "unknown",
      lookBack: (parsed.lookBack as DiagnoseIntent["lookBack"]) ?? "1h",
      urgency: (parsed.urgency as DiagnoseIntent["urgency"]) ?? "high",
    };
  }

  async run(question: string, awsRegion: string, k8sContext?: string): Promise<string> {
    console.log("");

    // ── 1. Parse intent ───────────────────────────────────────────────────
    const sp1 = new Spinner().start("Understanding your question");
    const intent = await this.parseQuestion(question).catch((err) => { sp1.fail(); throw err; });
    sp1.succeed("Understood");

    console.log("");
    printBoxHeader(`Diagnosing  ·  ${intent.serviceName}`);
    console.log("");
    printKV("Service",   c.bold(intent.serviceName),     { keyWidth: 12 });
    printKV("Problem",   intent.problem,                  { keyWidth: 12 });
    printKV("Urgency",   urgencyBadge(intent.urgency),    { keyWidth: 12 });
    printKV("Look-back", c.cyan(intent.lookBack),         { keyWidth: 12 });
    console.log("");

    // ── 2. Discover service across infrastructure ─────────────────────────
    const sp2 = new Spinner().start(`Discovering ${c.bold(intent.serviceName)} across infrastructure`);
    const discResult = await this.discovery.discover(intent.serviceName, awsRegion, k8sContext)
      .catch(() => ({ k8s: [], cloudWatchLogGroups: [], lokiUrl: undefined, openSearchUrl: undefined, openSearchIndex: undefined, openSearchUser: undefined, openSearchPass: undefined, summaryLines: [] }));
    sp2.succeed("Discovery complete");

    console.log("");
    if (discResult.k8s.length > 0) {
      for (const ns of discResult.k8s) {
        const parts = [
          ns.crashingPods.length > 0 ? c.red(`${ns.crashingPods.length} crashing`) : "",
          ns.pendingPods.length  > 0 ? c.yellow(`${ns.pendingPods.length} pending`)  : "",
          ns.runningPods.length  > 0 ? c.green(`${ns.runningPods.length} running`)   : "",
        ].filter(Boolean).join("  ");
        const total = ns.crashingPods.length + ns.pendingPods.length + ns.runningPods.length;
        printFound("Kubernetes", `ns=${c.bold(ns.namespace)}  ·  ${total} pods  (${parts})`);
        for (const p of ns.crashingPods) {
          process.stdout.write(
            `       ${c.dim(sym.tee)} ${c.dim(p.name)}` +
            (p.reason ? c.red(` [${p.reason}]`) : "") +
            (p.restarts > 0 ? c.dim(` ×${p.restarts}`) : "") + "\n",
          );
        }
      }
    } else {
      printSkipped("Kubernetes", "no matching pods  (kubectl unavailable or service not deployed)");
    }
    discResult.cloudWatchLogGroups.length > 0
      ? printFound("CW Logs", `${discResult.cloudWatchLogGroups.length} log group(s)`)
      : printSkipped("CW Logs", "no matching log groups  (check AWS credentials)");
    discResult.lokiUrl
      ? printFound("Loki", c.dim(discResult.lokiUrl))
      : printSkipped("Loki", `not configured  ${c.dim("(set LOKI_URL)")}`);
    discResult.openSearchUrl
      ? printFound("OpenSearch", c.dim(discResult.openSearchUrl))
      : printSkipped("OpenSearch", `not configured  ${c.dim("(set OPENSEARCH_URL)")}`);
    console.log("");

    // ── 3. Collect all signals in parallel ────────────────────────────────
    const sp3 = new Spinner().start("Collecting signals  ·  k8s + metrics + logs  (parallel)");

    const debugOptions: DebugOptions = {
      namespace: discResult.k8s[0]?.namespace,
      since: intent.lookBack,
      tailLines: 100,
      logGroups: discResult.cloudWatchLogGroups.length > 0 ? discResult.cloudWatchLogGroups : undefined,
      lokiUrl: discResult.lokiUrl,
      openSearchUrl: discResult.openSearchUrl,
      openSearchIndex: discResult.openSearchIndex,
      openSearchUser: discResult.openSearchUser,
      openSearchPass: discResult.openSearchPass,
      k8sContext,
      awsRegion,
    };

    const k8sQuery: AskK8sQuery = {
      resources: ["pods", "events", "deployments"],
      namespace: discResult.k8s[0]?.namespace,
    };

    const metricsCtx = metricsForProblem(intent.problem);
    metricsCtx.resourceId = intent.serviceName;

    const [aggregation, k8sData, metricsData] = await Promise.all([
      this.aggregator.collect(intent.serviceName, debugOptions).catch(() => ({
        signals: [], contributors: [], emptyProviders: [], skippedProviders: [],
      })),
      this.k8sInventory.query(k8sQuery).catch(() => ""),
      this.awsMetrics.query(metricsCtx, awsRegion).catch(() => ""),
    ]);

    sp3.succeed(
      `Signals collected  ${c.dim("·")}  ` +
      `logs=${c.bold(String(aggregation.signals.length))}  ` +
      `k8s=${c.bold(k8sData ? "yes" : "none")}  ` +
      `metrics=${c.bold(metricsData ? "yes" : "none")}`,
    );

    // ── 4. Deep dependency trace ──────────────────────────────────────────
    //
    // If crashing pods are found, trace service-to-service dependencies so
    // the LLM can determine whether the root cause lives in an upstream pod.
    // K8s auto-injects <SVC>_SERVICE_HOST env vars for every Service in the
    // namespace, giving us a free dependency graph with no manual config.
    //
    const hasCrashingPods = discResult.k8s.some((d) => d.crashingPods.length > 0);
    const rootNamespace   = discResult.k8s[0]?.namespace ?? "default";

    let depGraph: DependencyGraph | null = null;
    const depSignalBlocks: string[] = [];

    if (hasCrashingPods) {
      const sp4 = new Spinner().start("Deep-tracing cross-pod dependencies");
      try {
        const tracer = new K8sDependencyTracer();
        depGraph = await tracer.build(intent.serviceName, rootNamespace, k8sContext);
        const depNodes = depGraph.nodes.filter((n) => n.role === "dependency");

        if (depNodes.length > 0) {
          sp4.succeed(
            `Dependency graph built  ${c.dim("·")}  ` +
            `${depNodes.length} upstream service(s)  ${c.dim("·")}  ` +
            `${depGraph.edges.length} edge(s)`,
          );

          console.log("");
          printFound("Dep Graph", `${intent.serviceName} and its dependencies:`);
          renderDependencyTree(depGraph);
          console.log("");

          // Collect signals for each dependency service in parallel.
          const sp4b = new Spinner().start("Collecting dependency pod signals");
          await Promise.all(
            depNodes.map(async (node) => {
              const depAgg = await this.aggregator.collect(node.serviceName, {
                ...debugOptions,
                namespace: node.namespace,
              }).catch(() => ({ signals: [], contributors: [], emptyProviders: [], skippedProviders: [] }));

              if (depAgg.signals.length > 0) {
                depSignalBlocks.push(
                  `── DEPENDENCY: ${node.serviceName.toUpperCase()}  (hop=${node.hop}  pods=${node.pods.join(",")}  signals=${depAgg.signals.length}) ──\n` +
                  buildSignalBlock(depAgg.signals),
                );
              }
            }),
          );
          sp4b.succeed(
            `Dependency signals  ${c.dim("·")}  ` +
            `${depSignalBlocks.length}/${depNodes.length} service(s) with data`,
          );
        } else {
          sp4.succeed("No upstream dependencies detected");
        }
      } catch {
        sp4.fail("Dependency trace skipped  (kubectl unavailable or service not in cluster)");
      }
    }

    // ── 5. LLM analysis ───────────────────────────────────────────────────
    const sp5 = new Spinner().start("Analyzing with LLM");

    const depGraphSection =
      depGraph && depGraph.nodes.filter((n) => n.role === "dependency").length > 0
        ? [
            "── DEPENDENCY GRAPH ──",
            depGraph.edges.map((e) => `${e.from} → ${e.to}`).join("\n") || "(single service, no outbound deps)",
            "",
            ...depSignalBlocks.flatMap((b) => [b, ""]),
          ]
        : [];

    const prompt = [
      "You are a senior SRE performing live incident triage.",
      "Answer the user's question directly and completely, grounded in the data below.",
      "Never invent metrics, logs, or states that are not in the provided data.",
      "",
      `USER QUESTION : ${question}`,
      `SERVICE       : ${intent.serviceName}`,
      `PROBLEM TYPE  : ${intent.problem}`,
      `URGENCY       : ${intent.urgency.toUpperCase()}`,
      `LOOK-BACK     : ${intent.lookBack}`,
      `AWS REGION    : ${awsRegion}`,
      `ANALYSIS TIME : ${new Date().toISOString()}`,
      "",
      ...(k8sData ? ["── KUBERNETES STATE ──", k8sData, ""] : []),
      ...(metricsData ? ["── CLOUDWATCH METRICS ──", metricsData, ""] : []),
      `── OBSERVABILITY SIGNALS (${aggregation.signals.length} — sorted severity-first) ──`,
      buildSignalBlock(aggregation.signals),
      "",
      ...depGraphSection,
      "Respond EXACTLY in this format:",
      "",
      "## Direct Answer",
      "[One paragraph directly answering the user's question]",
      "",
      "## Root Cause",
      "**Most likely cause:** [one clear sentence]  (Confidence: HIGH | MEDIUM | LOW)",
      "",
      "**Evidence:**",
      "- [signal → what it proves]",
      "",
      "## Cross-Service Impact",
      "*(Fill this section ONLY if a dependency pod/service is involved in the root cause.)*",
      "- **Upstream service:** [name]  **Status:** [what is wrong]  **Effect on root:** [how it propagates]",
      "",
      "## Fix It Now  (< 30 min)",
      "1. [Exact kubectl / AWS CLI command] — [expected outcome]",
      "",
      "## Fix It Properly  (< 24 h)",
      "1. [Action] — [outcome]",
      "",
      "## Prevent Recurrence",
      "1. [Architectural or config change and why]",
      "",
      "## Impact",
      "- **Blast radius:** [who/what is affected]",
      "- **MTTR estimate:** [with rationale]",
      "- **Recurrence risk:** HIGH | MEDIUM | LOW",
    ].join("\n");

    const analysis = await this.bedrock.complete(prompt, { maxTokens: 2500 }).catch((err) => {
      sp5.fail("LLM analysis failed");
      throw err;
    });
    sp5.succeed("Analysis complete");

    // ── Build report ──────────────────────────────────────────────────────
    const sources = [
      ...aggregation.contributors,
      k8sData     ? "k8s-inventory"      : null,
      metricsData ? "cloudwatch-metrics" : null,
      depSignalBlocks.length > 0 ? `dep-trace(${depSignalBlocks.length})` : null,
    ].filter((s): s is string => !!s);

    const skipped = aggregation.skippedProviders.length > 0
      ? c.dim(`  Skipped   ${aggregation.skippedProviders.join(", ")}`)
      : null;

    const meta = [
      "",
      `    ${c.dim("Question".padEnd(12))}  ${question}`,
      `    ${c.dim("Service".padEnd(12))}  ${c.bold(intent.serviceName)}`,
      `    ${c.dim("Sources".padEnd(12))}  ${sources.join("  ·  ") || "none"}`,
      `    ${c.dim("Signals".padEnd(12))}  ${aggregation.signals.length} root  +  ${depSignalBlocks.reduce((acc, b) => acc + (b.match(/signals=(\d+)/)?.[1] ? parseInt(b.match(/signals=(\d+)/)![1], 10) : 0), 0)} dep`,
      ...(skipped ? [skipped] : []),
      "",
    ];

    return meta.join("\n") + renderReport(analysis);
  }
}
