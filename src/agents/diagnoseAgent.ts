/**
 * diagnoseAgent.ts
 *
 * Senior-SRE-grade agentic investigation loop.
 *
 * Investigation phases:
 *   1. TRIAGE      — parallel fan-out: error rates, request counts, active alarms
 *   2. SIGNALS     — corroborate across metrics, logs, health checks, deploy history
 *   3. HYPOTHESIZE — explicit working theory before every targeted query
 *   4. ROOT CAUSE  — conclude with evidence-backed specifics, not guesses
 *
 * When an AWS MCP server is configured (AWS_MCP_URL / AWS_MCP_TRANSPORT),
 * its tools are discovered at connect time and surfaced to the LLM via the
 * tool catalog so it can call richer, purpose-built AWS APIs directly.
 */

import { BedrockService } from "../services/bedrockService";
import { executeTool, buildToolCatalog, ToolContext } from "../services/diagnoseTools";
import { AwsMcpService } from "../services/awsMcpService";
import { parseJsonPayload } from "../utils/llm";
import { c, sym, Spinner, printBoxHeader, renderReport } from "../utils/terminal";
import { DebugOptions, AwsCredentials } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Step {
  tool: string;
  params: Record<string, string>;
  thought: string;
  result: string;
}

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

type LLMResponse =
  | { done: false; thought: string; tool: string;       params: Record<string, string>; calls?: never }
  | { done: false; thought: string; calls: ToolCall[];  tool?: never; params?: never }
  | { done: true;  thought: string; answer: string };

const MAX_STEPS = 20;

// ─── History compression ──────────────────────────────────────────────────────

function compressHistory(steps: Step[]): string {
  if (steps.length === 0) return "(no steps yet — begin triage)";
  const recentFrom = Math.max(0, steps.length - 3);
  return steps
    .map((s, i) => {
      if (i >= recentFrom) {
        const result = s.result.slice(0, 400) + (s.result.length > 400 ? "\n  ...(truncated)" : "");
        return `[${i + 1}] ${s.tool}(${JSON.stringify(s.params)})\n  THOUGHT: ${s.thought}\n  RESULT: ${result}`;
      }
      const keyLine = s.result.split("\n").find((l) => l.trim().length > 10) ?? s.result;
      return `[${i + 1}] ${s.tool} → ${keyLine.slice(0, 120)}`;
    })
    .join("\n\n");
}

// ─── Compact tool reference (used after step 1 to keep prompt short) ──────────

// COMPACT_TOOL_REF is rebuilt each run() to include live MCP tool names.
// This placeholder is only used as a fallback if mcpTools is empty.
const COMPACT_TOOL_REF_BASE =
  "run_command(command) | " +
  "aws_query(type,region?,name_filter?) | aws_get(type,identifier,region?) | " +
  "ec2_exec(instance_id,command,region?) | " +
  "cw_metrics(namespace,metric,dimensions?,since_hours?,statistic?) | " +
  "cw_logs(log_group,filter_pattern?,since_hours?)";

function buildCompactToolRef(mcpTools?: { name: string }[]): string {
  const base = `Tools: ${COMPACT_TOOL_REF_BASE}`;
  if (!mcpTools || mcpTools.length === 0) return base + "\nParallel: {\"calls\":[...]}";
  const names = mcpTools.map((t) => t.name).join(", ");
  return (
    base +
    `\nMCP tools (call by name directly, no wrapper needed): ${names}` +
    `\nParallel: {"calls":[{"tool":"...","params":{...}},{...}]}`
  );
}

// ─── SRE system prompt ────────────────────────────────────────────────────────

function systemPrompt(
  question: string,
  awsRegion: string,
  steps: Step[],
  options: DebugOptions,
  toolCatalog: string,
  mcpTools?: { name: string }[],
): string {
  const history    = compressHistory(steps);
  const toolSection = steps.length === 0 ? toolCatalog : buildCompactToolRef(mcpTools);

  const extraCtx: string[] = [];
  if (options.namespace)     extraCtx.push(`Kubernetes namespace: ${options.namespace}`);
  if (options.since)         extraCtx.push(`Look-back window: ${options.since}`);
  if (options.lokiUrl)       extraCtx.push(`Loki: ${options.lokiUrl} — query via run_command(curl)`);
  if (options.openSearchUrl) extraCtx.push(`OpenSearch: ${options.openSearchUrl} — query via run_command(curl)`);
  const extraSection = extraCtx.length > 0 ? `\nCONTEXT:\n${extraCtx.join("\n")}\n` : "";

  const phaseHint = getPhaseHint(steps.length);

  return `You are a SENIOR SRE (Site Reliability Engineer) conducting a structured incident investigation.
Your mission: identify the root cause efficiently using evidence — not guesswork.

${toolSection}
${extraSection}
═══ INVESTIGATION FRAMEWORK ════════════════════════════════════════════════════

${phaseHint}

═══ SRE CHECKLIST (work through this systematically) ═══════════════════════════

Error signature:
  • HTTP 5XX: Target5XX = app error  |  ELB5XX = infrastructure/routing error
  • HTTP 4XX: auth/permission issue or malformed request
  • Are errors from specific targets (single bad host) or all targets (systemic)?

Traffic & latency:
  • Request count: normal / spike / DROP? (a drop means something upstream is broken)
  • p50 vs p99 latency — p99-only spike = tail latency / GC pause / single hot host
  • TargetResponseTime = backend only  |  ELB latency includes connection setup

Health & capacity:
  • How many ELB targets are unhealthy vs healthy?
  • CPU / memory / connection pool saturation on targets?

Recent changes (most incidents trace to a deployment):
  • ECS/EKS service update or config change in the last 2 hours?
  • Auto-scaling event? New instances failing health checks?
  • Secrets rotation or parameter store change?

Dependencies:
  • Database connection errors? Pool exhausted?
  • External API or downstream service degraded?
  • DNS resolution issue? TLS certificate expiry?

Geographic scope:
  • Single AZ impact or multi-AZ? (single AZ = bad host/AZ; multi-AZ = systemic)

═══ RULES ══════════════════════════════════════════════════════════════════════

1. TRIAGE FIRST — always fan-out in parallel on the first step.
2. QUANTIFY everything — use exact numbers ("41 errors in 5 min" not "some errors").
3. STATE YOUR HYPOTHESIS in "thought" before each targeted query.
4. MCP tools are callable by name directly — e.g. {"tool":"get_active_alarms","params":{...}}.
   You do NOT need to wrap them in mcp_tool(); just use the tool name directly.
5. PREFER MCP tools over SDK tools (analyze_metric > cw_metrics, execute_log_insights_query > cw_logs).
   analyze_metric requires: namespace, metric_name, dimensions (array of {name,value}),
     start_time and end_time as ISO-8601 strings (e.g. "2026-04-02T10:00:00Z").
   execute_log_insights_query requires: log_group_names (array), query_string (Logs Insights SQL),
     start_time and end_time as Unix epoch seconds (integers).
6. ALB CloudWatch dimension: ALWAYS get the ARN first via aws_query with name_filter, then extract
   the dimension value from LoadBalancerArn as the suffix after "loadbalancer/" (e.g.
   arn:...:loadbalancer/app/my-alb/abc123 → LoadBalancer=app/my-alb/abc123).
7. RETRY LIMIT — if the same tool call fails or returns empty twice, STOP retrying it.
   Use a different tool or different approach, or conclude with the evidence you have.
8. TRUNCATED RESULTS — if aws_get returns truncated data, do NOT repeat the same call.
   Extract the key fields already visible and move on.
9. CONCLUDE at >80% confidence — don't over-investigate obvious root causes.

═══ RESPONSE FORMAT — one valid JSON object, no markdown fences ════════════════

Single tool:   {"thought":"<hypothesis>","tool":"<name>","params":{...},"done":false}
Parallel:      {"thought":"<triage rationale>","calls":[{"tool":"...","params":{...}},...],"done":false}
Conclusion:    {"thought":"...","done":true,"answer":"<see conclusion format below>"}

CONCLUSION FORMAT:
## Incident Summary
**Severity**: P[1-3] | **Impact**: [what is broken and scope] | **Started**: [ISO timestamp or approximate]

## Root Cause
[One sentence naming the SPECIFIC component/change that caused the issue, with evidence]

## Evidence
- [Metric]: [exact values with timestamps]
- [Log/alarm]: [specific message and count]

## Immediate Action
1. \`[specific command or AWS console action]\`

## Permanent Fix
1. [code/configuration change required]

## Prevention
1. [alert rule or process improvement]

═════════════════════════════════════════════════════════════════════════════════

PROBLEM  : ${question}
REGION   : ${awsRegion}
TIME     : ${new Date().toISOString()}

INVESTIGATION HISTORY (${steps.length} steps completed):
${history}

Your next action:`;
}

/** Return a phase-specific nudge based on how many steps have been taken. */
function getPhaseHint(stepCount: number): string {
  if (stepCount === 0) {
    return `CURRENT PHASE: TRIAGE
→ Use parallel calls to simultaneously check error rates, request counts, and active alarms.
→ Goal: understand scope (all users? one AZ? specific service?) before any deep-dive.`;
  }
  if (stepCount <= 4) {
    return `CURRENT PHASE: SIGNAL COLLECTION
→ You have initial triage data. Now corroborate with logs, health checks, and deploy history.
→ Correlate timestamps — the exact moment an anomaly begins reveals what changed.`;
  }
  if (stepCount <= 10) {
    return `CURRENT PHASE: HYPOTHESIS & VALIDATION
→ State your working theory explicitly. Run the ONE query that confirms or denies it.
→ Rule out infrastructure before blaming application code.`;
  }
  return `CURRENT PHASE: ROOT CAUSE
→ You have enough evidence. Conclude now with specific root cause and actionable remediation.
→ If still uncertain, name the most likely cause and what additional evidence would confirm it.`;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class DiagnoseAgent {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly mcpService?: AwsMcpService,
  ) {}

  async run(
    question: string,
    awsRegion: string,
    options: DebugOptions = {},
    credentials?: AwsCredentials,
  ): Promise<string> {
    console.log("");
    printBoxHeader(`Investigating · ${question.slice(0, 60)}`);
    console.log("");

    // ── Try to connect AWS MCP servers (non-blocking) ────────────────────────
    if (this.mcpService && !this.mcpService.isConnected()) {
      const sp = new Spinner().start("Connecting to AWS MCP servers…");
      const ok = await this.mcpService.connect();
      if (ok) {
        const servers = this.mcpService.getConnectedServers();
        const count   = this.mcpService.getDiscoveredTools().length;
        sp.succeed(
          `AWS MCP  ${c.dim("·")}  ${c.bold(servers.join(", "))}  ` +
          `${c.dim(`·  ${count} tool${count !== 1 ? "s" : ""} available`)}`,
        );
      } else {
        sp.fail(
          c.dim("AWS MCP not configured — using SDK tools only") + "\n" +
          c.dim("  → Install uv to enable:  curl -LsSf https://astral.sh/uv/install.sh | sh") + "\n" +
          c.dim("  → Then set:              AWS_MCP_SERVERS=cloudwatch,cloudtrail"),
        );
      }
      console.log("");
    }

    // ── Build dynamic tool catalog (includes MCP tools if connected) ─────────
    const mcpTools = this.mcpService?.isConnected()
      ? this.mcpService.getDiscoveredTools()
      : undefined;
    const toolCatalog = buildToolCatalog(mcpTools);

    const ctx: ToolContext = {
      awsRegion,
      k8sContext: options.k8sContext,
      awsCredentials: credentials,
      mcpService: this.mcpService,
    };

    const steps: Step[] = [];
    let finalAnswer = "";
    let stepNum = 0;

    while (stepNum < MAX_STEPS) {
      stepNum++;

      // ── Ask LLM what to do next ────────────────────────────────────────────
      const sp = new Spinner().start(`Step ${stepNum}/${MAX_STEPS}  ·  thinking…`);
      let raw: string;
      try {
        raw = await this.bedrock.complete(
          systemPrompt(question, awsRegion, steps, options, toolCatalog, mcpTools),
          { maxTokens: 2048 },
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sp.fail(`Step ${stepNum} — LLM error: ${errMsg}`);
        throw err;
      }
      sp.fail(""); // clear spinner line

      // ── Parse LLM response ─────────────────────────────────────────────────
      let parsed: LLMResponse;
      try {
        parsed = parseJsonPayload(raw, `step ${stepNum}`) as LLMResponse;
      } catch {
        process.stdout.write(
          `\n  ${c.dim(`[${stepNum}]`)} ${c.red("parse error")}  ${c.dim(raw.slice(0, 100))}\n`,
        );
        steps.push({ tool: "_parse_error", params: {}, thought: "unparseable", result: raw.slice(0, 300) });
        continue;
      }

      // ── Done? ──────────────────────────────────────────────────────────────
      if (parsed.done) {
        process.stdout.write(
          `\n  ${c.bold(c.green(sym.check))} ${c.dim(`[${stepNum}]`)} ${c.bold("conclusion")}  ` +
          `${c.dim(parsed.thought.slice(0, 80))}\n`,
        );
        finalAnswer = (parsed as { done: true; answer: string }).answer;
        break;
      }

      // ── Parallel calls ─────────────────────────────────────────────────────
      if ((parsed as { calls?: ToolCall[] }).calls?.length) {
        const { thought, calls } = parsed as { done: false; thought: string; calls: ToolCall[] };

        process.stdout.write(
          `\n  ${c.bold(c.cyan(sym.dot))} ${c.dim(`[${stepNum}]`)} ${c.bold(`parallel ×${calls.length}`)}` +
          `  ${c.dim("→")} ${thought.slice(0, 80)}\n`,
        );

        const results = await Promise.all(
          calls.map(async (call) => ({
            call,
            result: await executeTool(call.tool, call.params, ctx),
          })),
        );

        for (const { call, result } of results) {
          const label = call.tool === "mcp_tool"
            ? `mcp:${call.params["name"] ?? "?"}`
            : call.tool;
          const preview = result.split("\n")[0].slice(0, 100);
          process.stdout.write(`         ${c.bold(label)}  ${c.dim(preview)}\n`);
          steps.push({ tool: call.tool, params: call.params, thought, result });
        }

        stepNum += calls.length - 1;
        continue;
      }

      // ── Single tool call ───────────────────────────────────────────────────
      const { tool, params, thought } = parsed as {
        done: false; tool: string; params: Record<string, string>; thought: string;
      };

      const label = tool === "mcp_tool" ? `mcp:${params["name"] ?? "?"}` : tool;
      process.stdout.write(
        `\n  ${c.bold(c.cyan(sym.dot))} ${c.dim(`[${stepNum}]`)} ${c.bold(label)}` +
        `  ${c.dim("→")} ${thought.slice(0, 90)}\n`,
      );

      const result = await executeTool(tool, params, ctx);
      const preview = result.split("\n")[0].slice(0, 100);
      process.stdout.write(`         ${c.dim(preview)}\n`);

      steps.push({ tool, params, thought, result });
    }

    // ── Force conclusion if step limit reached ───────────────────────────────
    if (!finalAnswer) {
      const sp = new Spinner().start("Summarising findings…");
      try {
        const forcePrompt =
          systemPrompt(question, awsRegion, steps, options, toolCatalog, mcpTools) +
          "\n\nStep limit reached. You MUST conclude now — set done=true and give your best root cause using all evidence gathered.";
        const raw2 = await this.bedrock.complete(forcePrompt, { maxTokens: 2048 });
        const p2 = parseJsonPayload(raw2, "force-conclusion") as LLMResponse;
        finalAnswer = p2.done
          ? (p2 as { done: true; answer: string }).answer
          : buildFallbackAnswer(steps);
        sp.succeed("Summary complete");
      } catch {
        sp.fail("Summary failed");
        finalAnswer = buildFallbackAnswer(steps);
      }
    }

    console.log("");
    return renderReport(finalAnswer);
  }
}

// ─── Fallback when LLM can't conclude ────────────────────────────────────────

function buildFallbackAnswer(steps: Step[]): string {
  const evidence = steps
    .filter((s) => !s.tool.startsWith("_"))
    .map((s, i) => {
      const label = s.tool === "mcp_tool" ? `mcp:${s.params["name"] ?? "?"}` : s.tool;
      return `**Step ${i + 1} [${label}]:** ${s.result.slice(0, 300)}`;
    })
    .join("\n\n");

  return `## Investigation Summary\n\nCompleted ${steps.length} investigation steps. Evidence gathered:\n\n${evidence}`;
}
