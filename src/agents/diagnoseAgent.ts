/**
 * diagnoseAgent.ts
 *
 * Senior SRE investigation engine — thinks like a Staff+ on-call engineer.
 *
 * Investigation methodology (modeled on real incident response):
 *
 *   Phase 1: TRIAGE (step 0)
 *     Wide parallel fan-out: error rates, latency, target health, recent deploys,
 *     k8s pod status, active alarms. Goal: scope the blast radius in one shot.
 *
 *   Phase 2: CORRELATE (steps 1–5)
 *     Cross-reference signals. Align timestamps. Separate cause from symptom.
 *     Key question: "What changed right BEFORE the first anomaly?"
 *
 *   Phase 3: HYPOTHESIS (steps 6–12)
 *     Form a specific, falsifiable theory. Run the ONE query that proves or
 *     disproves it. Pivot or narrow.
 *
 *   Phase 4: ROOT CAUSE (steps 13+)
 *     Lock in root cause with evidence chain. Build remediation.
 *
 * Anti-patterns the agent actively avoids:
 *   - "Shotgun debugging" — querying random things without a hypothesis
 *   - "Tunnel vision"     — fixating on the first anomaly without checking scope
 *   - "Metric fishing"    — re-querying the same metric with different windows
 *   - "Premature blame"   — concluding "it's the app" before ruling out infra
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
  /** Wall-clock milliseconds this tool call took. */
  durationMs: number;
}

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

type LLMResponse =
  | { done: false; thought: string; tool: string;       params: Record<string, string>; calls?: never }
  | { done: false; thought: string; calls: ToolCall[];  tool?: never; params?: never }
  | { done: true;  thought: string; answer: string };

const MAX_STEPS = 25;

// Token budget: tool-call steps are short JSON; conclusions need room for full report.
const STEP_MAX_TOKENS = 3072;
const CONCLUSION_MAX_TOKENS = 4096;

// ─── Evidence tracker ─────────────────────────────────────────────────────────
// Extracts key findings from tool results so the LLM doesn't lose them during
// history compression. Presented as a "evidence board" in every prompt.

interface Finding {
  step: number;
  signal: string;  // one-line summary of what was found
  severity: "critical" | "warning" | "info";
}

function extractFindings(steps: Step[]): Finding[] {
  const findings: Finding[] = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const r = s.result.toLowerCase();
    const stepNum = i + 1;

    // Error-rate signals
    if (r.includes("5xx") || r.includes("error") || r.includes("failed") || r.includes("unhealthy")) {
      const line = s.result.split("\n").find((l) =>
        /5xx|error|fail|unhealthy/i.test(l)
      )?.trim().slice(0, 150);
      if (line) findings.push({ step: stepNum, signal: line, severity: "critical" });
    }

    // Deployment / change signals
    if (r.includes("updateservice") || r.includes("createdeployment") || r.includes("rollout") || r.includes("deploy")) {
      const line = s.result.split("\n").find((l) =>
        /deploy|rollout|updateservice|createdeployment/i.test(l)
      )?.trim().slice(0, 150);
      if (line) findings.push({ step: stepNum, signal: `CHANGE: ${line}`, severity: "warning" });
    }

    // CrashLoop / OOM / restart signals
    if (r.includes("crashloopbackoff") || r.includes("oomkilled") || r.includes("restarts=") || r.includes("exit=137")) {
      const line = s.result.split("\n").find((l) =>
        /crashloop|oomkill|restarts=[1-9]|exit=137|exit=1/i.test(l)
      )?.trim().slice(0, 150);
      if (line) findings.push({ step: stepNum, signal: line, severity: "critical" });
    }

    // High metric values
    if (s.tool === "cw_metrics" || s.tool === "analyze_metric") {
      const maxMatch = s.result.match(/max=(\d+\.?\d*)/);
      const avgMatch = s.result.match(/avg=(\d+\.?\d*)/);
      if (maxMatch) {
        const header = s.result.split("\n")[0]?.slice(0, 120) ?? "";
        findings.push({ step: stepNum, signal: `METRIC: ${header} (max=${maxMatch[1]}, avg=${avgMatch?.[1] ?? "?"})`, severity: "info" });
      }
    }

    // Stopped task reasons
    if (r.includes("stoppedreason=") && !r.includes("stoppedreason=n/a")) {
      const line = s.result.split("\n").find((l) =>
        /stoppedreason=(?!n\/a)/i.test(l)
      )?.trim().slice(0, 150);
      if (line) findings.push({ step: stepNum, signal: line, severity: "critical" });
    }

    // Scaling events
    if (r.includes("scaling") && (r.includes("terminate") || r.includes("launch"))) {
      const line = s.result.split("\n").find((l) =>
        /scaling.*(?:launch|terminate)/i.test(l)
      )?.trim().slice(0, 150);
      if (line) findings.push({ step: stepNum, signal: `SCALING: ${line}`, severity: "warning" });
    }
  }

  // Deduplicate similar findings
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = f.signal.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15); // cap at 15 most important findings
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => {
    const icon = f.severity === "critical" ? "!!" : f.severity === "warning" ? "!" : "-";
    return `  [${icon}] (step ${f.step}) ${f.signal}`;
  });
  return `\n═══ EVIDENCE BOARD (key findings so far) ═══════════════════════════════════════\n${lines.join("\n")}\n`;
}

// ─── History compression ──────────────────────────────────────────────────────

function compressHistory(steps: Step[]): string {
  if (steps.length === 0) return "(no steps yet — begin triage)";
  // Show last 5 steps in full detail, compress older ones to key findings
  const recentFrom = Math.max(0, steps.length - 5);
  return steps
    .map((s, i) => {
      if (i >= recentFrom) {
        const result = s.result.slice(0, 1000) + (s.result.length > 1000 ? "\n  ...(truncated)" : "");
        return `[${i + 1}] ${s.tool}(${JSON.stringify(s.params)})  [${s.durationMs}ms]\n  THOUGHT: ${s.thought}\n  RESULT: ${result}`;
      }
      // Older steps: keep 2 key lines
      const keyLines = s.result.split("\n").filter((l) => l.trim().length > 10).slice(0, 2);
      return `[${i + 1}] ${s.tool} → ${keyLines.join(" | ").slice(0, 250)}`;
    })
    .join("\n\n");
}

// ─── Compact tool reference (used after step 1 to keep prompt short) ──────────

const COMPACT_TOOL_REF =
  "run_command(command) | " +
  "aws_query(type,region?,name_filter?) | aws_get(type,identifier,region?) | " +
  "ec2_exec(instance_id,command,region?) | " +
  "cw_metrics(namespace,metric,dimensions?,since_hours?,statistic?) | " +
  "cw_logs(log_group,filter_pattern?,since_hours?) | pi_top_sql(instance,top?,since_hours?) | " +
  "ecs_describe(cluster?,service?,task_id?) | elb_health(load_balancer?,target_group?) | " +
  "cloudtrail(event_name?,resource_name?,since_hours?) | asg_activity(asg_name?) | " +
  "route53_check(domain?,zone_id?) | " +
  "k8s_pods(namespace?,selector?) | k8s_events(namespace?,severity?,since?) | k8s_logs(pod,namespace?,grep?,previous?)";

function buildCompactToolRef(mcpTools?: { name: string }[]): string {
  const base = `Tools: ${COMPACT_TOOL_REF}`;
  if (!mcpTools || mcpTools.length === 0) return base + "\nParallel: {\"calls\":[...]}";
  const names = mcpTools.map((t) => t.name).join(", ");
  return (
    base +
    `\nMCP tools (call by name directly): ${names}` +
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
  const history       = compressHistory(steps);
  const toolSection   = steps.length === 0 ? toolCatalog : buildCompactToolRef(mcpTools);
  const findings      = extractFindings(steps);
  const evidenceBoard = formatFindings(findings);

  const extraCtx: string[] = [];
  if (options.namespace)     extraCtx.push(`Kubernetes namespace: ${options.namespace}`);
  if (options.since)         extraCtx.push(`Look-back window: ${options.since}`);
  if (options.lokiUrl)       extraCtx.push(`Loki: ${options.lokiUrl} — query via run_command(curl)`);
  if (options.openSearchUrl) extraCtx.push(`OpenSearch: ${options.openSearchUrl} — query via run_command(curl)`);
  const extraSection = extraCtx.length > 0 ? `\nCONTEXT:\n${extraCtx.join("\n")}\n` : "";

  const phaseHint = getPhaseHint(steps, findings);

  return `You are a SENIOR SRE (Staff+ Site Reliability Engineer) conducting a structured incident investigation.
Your mission: find the root cause efficiently using evidence, not guesswork.
Think like a detective — every tool call should either narrow the suspect list or confirm a theory.

${toolSection}
${extraSection}
═══ INVESTIGATION METHODOLOGY ═════════════════════════════════════════════════

${phaseHint}
${evidenceBoard}
═══ SRE DECISION FRAMEWORK ═════════════════════════════════════════════════════

When you see an anomaly, ask: "Is this the CAUSE or a SYMPTOM?"
  → High CPU is usually a SYMPTOM. What's driving it? (bad query? traffic spike? memory pressure?)
  → 5XX errors are a SYMPTOM. What's generating them? (unhealthy targets? app crash? timeout?)
  → Pod restarts are a SYMPTOM. What's killing the pod? (OOM? liveness probe? app panic?)

INCIDENT PATTERN RECOGNITION:
  Deploy-related (most common):
    Signal: anomaly starts within 30 min of a deployment.
    Verify: cloudtrail → ecs_describe/k8s_events → compare deploy timestamp vs anomaly start.

  Resource exhaustion:
    Signal: gradual degradation, not sudden. CPU/memory/connections approaching limits.
    Verify: cw_metrics time series → look for ramp-up pattern, not step change.

  Dependency failure:
    Signal: upstream service errors, DNS failures, connection timeouts in logs.
    Verify: cw_logs for connection errors → downstream service health → route53_check.

  Traffic spike / DDoS:
    Signal: sudden request count increase + all targets affected equally.
    Verify: cw_metrics RequestCount → compare to baseline → check if organic.

  Single-host / AZ issue:
    Signal: errors from specific targets only, not all.
    Verify: elb_health → identify unhealthy targets → check that host's metrics/logs.

TOOL SELECTION GUIDE:
  "Service is down"          → elb_health + ecs_describe/k8s_pods + cw_metrics(5XX)
  "Latency is high"          → cw_metrics(TargetResponseTime) + pi_top_sql + cw_logs
  "Pods crashing"            → k8s_pods + k8s_events + k8s_logs(previous=true)
  "DB is slow"               → pi_top_sql + cw_metrics(DBLoad,CPUUtilization,DatabaseConnections)
  "What changed?"            → cloudtrail + ecs_describe(deployments) + k8s_events
  "Scaling issues"           → asg_activity + cw_metrics(CPU) + elb_health
  "Connection errors"        → cw_logs + route53_check + run_command(dig/curl)
  "Errors after deployment"  → ecs_describe + cloudtrail + cw_logs + elb_health

═══ RULES ══════════════════════════════════════════════════════════════════════

1. TRIAGE FIRST — always fan-out 4-6 parallel calls on step 1. Cover: errors, latency,
   target health, recent changes, and resource status. Cast a WIDE net.
2. QUANTIFY — use exact numbers and timestamps ("417 5XX errors between 10:30–10:45" not "some errors").
3. HYPOTHESIZE — state your working theory in "thought" BEFORE each query. If you don't have a
   hypothesis, you're fishing — stop and form one from the evidence board.
4. CORRELATE TIMESTAMPS — the minute an anomaly starts is the most important signal.
   Align deployment times, metric changes, and log errors on the same timeline.
5. MCP tools are callable by name directly: {"tool":"get_active_alarms","params":{...}}.
   PREFER MCP tools over SDK tools when available.
6. ALB dimension: get ARN via aws_query(name_filter=...), then LoadBalancer=app/<name>/<hash>.
7. RETRY LIMIT — same call fails/empty twice → use a different approach or conclude.
8. TRUNCATED RESULTS — extract visible fields and move on. Do NOT repeat.
9. CONCLUDE at >80% confidence — don't over-investigate. Name the root cause, cite
   the evidence chain, and give specific remediation.
10. ONE HYPOTHESIS AT A TIME — don't run 3 different theories in parallel. Pick the
    most likely one, test it, then pivot if disproved.

═══ RESPONSE FORMAT — one valid JSON object, no markdown fences ════════════════

Single tool:   {"thought":"<hypothesis being tested>","tool":"<name>","params":{...},"done":false}
Parallel:      {"thought":"<triage rationale>","calls":[{"tool":"...","params":{...}},...],"done":false}
Conclusion:    {"thought":"<evidence chain summary>","done":true,"answer":"<see format below>"}

CONCLUSION FORMAT — be specific and actionable:

## Incident Summary
**Severity**: P1/P2/P3 | **Impact**: [what is broken, who is affected, scope] | **Duration**: [start → end or ongoing]

## Root Cause
[One clear sentence: WHAT failed, WHY it failed, and WHEN it started. Include the specific component, change, or condition.]

## Evidence Chain
1. [First signal]: [exact values with timestamps]
2. [Corroborating signal]: [exact values with timestamps]
3. [Confirming evidence]: [what proved the root cause]

## Timeline
- [HH:MM UTC] — [event that triggered the incident]
- [HH:MM UTC] — [first impact observed]
- [HH:MM UTC] — [escalation or additional impact]

## Immediate Remediation
1. \`[specific CLI command, SQL, or console action]\`
2. \`[second action if needed]\`

## Permanent Fix
1. [code/config change with rationale]

## Prevention
1. [alert/monitor to catch this earlier]
2. [process/architecture change to prevent recurrence]

═════════════════════════════════════════════════════════════════════════════════

PROBLEM  : ${question}
REGION   : ${awsRegion}
TIME     : ${new Date().toISOString()}

INVESTIGATION HISTORY (${steps.length} steps, ${steps.reduce((a, s) => a + s.durationMs, 0)}ms total):
${history}

Your next action:`;
}

/** Phase-specific guidance based on progress and evidence quality. */
function getPhaseHint(steps: Step[], findings: Finding[]): string {
  const n = steps.length;
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasChange   = findings.some((f) => f.signal.startsWith("CHANGE:"));

  if (n === 0) {
    return `CURRENT PHASE: TRIAGE (cast a wide net)
→ Launch 4-6 parallel calls to scope the incident:
  • Error rates: cw_metrics for 5XX counts, or elb_health for target status
  • Latency: cw_metrics for TargetResponseTime or service response times
  • Resource status: ecs_describe or k8s_pods to see current state
  • Recent changes: cloudtrail(since_hours=3) for deploys and config changes
  • Logs: cw_logs for recent errors in the affected service
  • Infrastructure: cw_metrics for CPU/memory/connections
→ Goal: determine SCOPE (all users? one service? one AZ?) and TIMING (when did it start?)
→ DO NOT deep-dive yet. Breadth first, depth second.`;
  }

  if (n <= 5) {
    if (hasCritical && hasChange) {
      return `CURRENT PHASE: CORRELATE (you have critical signals AND a change detected)
→ Priority: correlate the deployment/change timestamp with the anomaly start time.
→ Check: did the change happen BEFORE the anomaly? If yes, strong deploy-related signal.
→ Get deployment details: ecs_describe(service) for rollout state, k8s_events for rollout events.
→ Compare: what's different in the new version? (new task def, new image, config change?)`;
    }
    if (hasCritical) {
      return `CURRENT PHASE: CORRELATE (critical signals detected — find the trigger)
→ You see symptoms. Now find what CAUSED them.
→ Check cloudtrail for recent changes if you haven't already.
→ Look at the TIMELINE: when exactly did the anomaly start? What happened just before?
→ Check dependencies: DB metrics, downstream services, DNS resolution.`;
    }
    return `CURRENT PHASE: SIGNAL COLLECTION (need more data)
→ Initial triage is done. Corroborate with additional sources.
→ Cross-reference timestamps between metrics, logs, and events.
→ The minute anomaly starts is your strongest clue — align all signals to it.`;
  }

  if (n <= 12) {
    if (hasCritical) {
      return `CURRENT PHASE: HYPOTHESIS TESTING (you have ${findings.filter((f) => f.severity === "critical").length} critical findings)
→ State your #1 theory in "thought". What SPECIFICALLY do you think caused this?
→ Run the ONE query that would DISPROVE your theory. If it holds, conclude.
→ Rule out infrastructure before blaming application code.
→ If your theory is deploy-related: what exactly changed? Task def? Config? Secrets?
→ If resource exhaustion: what is growing and why? Is it a leak or legitimate load?`;
    }
    return `CURRENT PHASE: HYPOTHESIS TESTING
→ Form a specific theory from the evidence board above.
→ Test it with a targeted query. One theory at a time.
→ If no anomalies found yet, widen scope: check other regions, other services, external deps.`;
  }

  return `CURRENT PHASE: CONCLUDE NOW
→ You have ${steps.length} steps and ${findings.length} findings. This is enough evidence.
→ Name the root cause. If uncertain, state the MOST LIKELY cause and what would confirm it.
→ Set done=true. Do not run more queries.
→ Include the full evidence chain and specific remediation in your conclusion.`;
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
    let consecutiveErrors = 0;

    while (stepNum < MAX_STEPS) {
      stepNum++;

      // ── Ask LLM what to do next ────────────────────────────────────────────
      const sp = new Spinner().start(`Step ${stepNum}/${MAX_STEPS}  ·  thinking…`);
      let raw: string;
      try {
        raw = await this.bedrock.complete(
          systemPrompt(question, awsRegion, steps, options, toolCatalog, mcpTools),
          { maxTokens: STEP_MAX_TOKENS },
        );
        consecutiveErrors = 0;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sp.fail(`Step ${stepNum} — LLM error: ${errMsg}`);
        consecutiveErrors++;
        if (consecutiveErrors >= 3) throw err;
        continue;
      }
      sp.fail(""); // clear spinner line

      // ── Parse LLM response ─────────────────────────────────────────────────
      let parsed: LLMResponse;
      try {
        parsed = parseJsonPayload(raw, `step ${stepNum}`) as LLMResponse;
      } catch {
        // Detect truncated conclusion — retry with more tokens
        if (raw.includes('"done"') && raw.includes('"answer"') && raw.length > 1500) {
          process.stdout.write(
            `\n  ${c.dim(`[${stepNum}]`)} ${c.yellow("truncated conclusion — retrying with more tokens…")}\n`,
          );
          try {
            const retryRaw = await this.bedrock.complete(
              systemPrompt(question, awsRegion, steps, options, toolCatalog, mcpTools) +
              "\n\nYour previous conclusion was truncated. Conclude NOW with done=true. Be complete but concise — no code blocks longer than 3 lines. Prioritize the evidence chain and remediation steps.",
              { maxTokens: CONCLUSION_MAX_TOKENS },
            );
            parsed = parseJsonPayload(retryRaw, `step ${stepNum} retry`) as LLMResponse;
          } catch {
            process.stdout.write(
              `\n  ${c.dim(`[${stepNum}]`)} ${c.red("parse error after retry")}  ${c.dim(raw.slice(0, 100))}\n`,
            );
            steps.push({ tool: "_parse_error", params: {}, thought: "unparseable", result: raw.slice(0, 300), durationMs: 0 });
            continue;
          }
        } else {
          process.stdout.write(
            `\n  ${c.dim(`[${stepNum}]`)} ${c.red("parse error")}  ${c.dim(raw.slice(0, 100))}\n`,
          );
          steps.push({ tool: "_parse_error", params: {}, thought: "unparseable", result: raw.slice(0, 300), durationMs: 0 });
          continue;
        }
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

        // Cap parallel fan-out to avoid runaway
        const safeCalls = calls.slice(0, 8);

        process.stdout.write(
          `\n  ${c.bold(c.cyan(sym.dot))} ${c.dim(`[${stepNum}]`)} ${c.bold(`parallel x${safeCalls.length}`)}` +
          `  ${c.dim("→")} ${thought.slice(0, 80)}\n`,
        );

        const t0 = Date.now();
        const results = await Promise.all(
          safeCalls.map(async (call) => {
            const start = Date.now();
            const result = await executeTool(call.tool, call.params, ctx);
            return { call, result, durationMs: Date.now() - start };
          }),
        );
        const wallMs = Date.now() - t0;

        for (const { call, result, durationMs } of results) {
          const label = call.tool === "mcp_tool"
            ? `mcp:${call.params["name"] ?? "?"}`
            : call.tool;
          const preview = result.split("\n")[0].slice(0, 100);
          process.stdout.write(`         ${c.bold(label)}  ${c.dim(preview)}  ${c.dim(`${durationMs}ms`)}\n`);
          steps.push({ tool: call.tool, params: call.params, thought, result, durationMs });
        }

        // Count parallel batch as 1 step + (N-1) for the extra calls
        stepNum += safeCalls.length - 1;

        process.stdout.write(`         ${c.dim(`(${safeCalls.length} calls, ${wallMs}ms wall time)`)}\n`);
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

      const t0 = Date.now();
      const result = await executeTool(tool, params, ctx);
      const durationMs = Date.now() - t0;
      const preview = result.split("\n")[0].slice(0, 100);
      process.stdout.write(`         ${c.dim(preview)}  ${c.dim(`${durationMs}ms`)}\n`);

      steps.push({ tool, params, thought, result, durationMs });
    }

    // ── Force conclusion if step limit reached ───────────────────────────────
    if (!finalAnswer) {
      const sp = new Spinner().start("Synthesising root cause analysis…");
      try {
        const forcePrompt =
          systemPrompt(question, awsRegion, steps, options, toolCatalog, mcpTools) +
          "\n\nStep limit reached. You MUST conclude now with done=true. " +
          "Use the evidence board above. Name the most likely root cause with the evidence chain. " +
          "If uncertain, rank your top 2 hypotheses by likelihood.";
        const raw2 = await this.bedrock.complete(forcePrompt, { maxTokens: CONCLUSION_MAX_TOKENS });
        const p2 = parseJsonPayload(raw2, "force-conclusion") as LLMResponse;
        finalAnswer = p2.done
          ? (p2 as { done: true; answer: string }).answer
          : buildFallbackAnswer(steps);
        sp.succeed("Analysis complete");
      } catch {
        sp.fail("Summary failed — building fallback from evidence");
        finalAnswer = buildFallbackAnswer(steps);
      }
    }

    // ── Stats line ──────────────────────────────────────────────────────────
    const totalMs = steps.reduce((a, s) => a + s.durationMs, 0);
    const toolCalls = steps.filter((s) => !s.tool.startsWith("_")).length;
    console.log("");
    process.stdout.write(
      c.dim(`  Investigation: ${toolCalls} tool calls, ${steps.length} steps, ${(totalMs / 1000).toFixed(1)}s execution time\n`),
    );
    console.log("");

    return renderReport(finalAnswer);
  }
}

// ─── Fallback when LLM can't conclude ────────────────────────────────────────

function buildFallbackAnswer(steps: Step[]): string {
  const findings = extractFindings(steps);

  const criticalFindings = findings.filter((f) => f.severity === "critical");
  const warningFindings = findings.filter((f) => f.severity === "warning");

  let summary = `## Investigation Summary\n\nCompleted ${steps.length} investigation steps.\n\n`;

  if (criticalFindings.length > 0) {
    summary += `### Critical Findings\n`;
    for (const f of criticalFindings) {
      summary += `- (step ${f.step}) ${f.signal}\n`;
    }
    summary += "\n";
  }

  if (warningFindings.length > 0) {
    summary += `### Changes Detected\n`;
    for (const f of warningFindings) {
      summary += `- (step ${f.step}) ${f.signal}\n`;
    }
    summary += "\n";
  }

  summary += `### Raw Evidence\n\n`;
  const evidence = steps
    .filter((s) => !s.tool.startsWith("_"))
    .slice(-8) // last 8 steps
    .map((s, i) => {
      const label = s.tool === "mcp_tool" ? `mcp:${s.params["name"] ?? "?"}` : s.tool;
      return `**Step ${i + 1} [${label}]:** ${s.result.slice(0, 400)}`;
    })
    .join("\n\n");

  return summary + evidence;
}
