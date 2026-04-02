/**
 * diagnoseAgent.ts
 *
 * Single agentic ReAct loop for all infrastructure investigation.
 * Handles both:
 *   - Free-form questions: "why is mimir crashing?"
 *   - Service-anchored debug: --service checkout-api + DebugOptions
 *
 * The LLM gets six generic primitives and decides at every step what to
 * investigate. No cases are pre-defined. The loop continues until the LLM
 * declares done.
 *
 * Parallel fan-out: the LLM may return a `calls` array to run independent
 * queries concurrently (Promise.all) in a single logical step.
 */

import { BedrockService } from "../services/bedrockService";
import { executeTool, buildToolCatalog, ToolContext } from "../services/diagnoseTools";
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
  if (steps.length === 0) return "(no steps yet)";
  const recentFrom = Math.max(0, steps.length - 3);
  return steps
    .map((s, i) => {
      if (i >= recentFrom) {
        const result = s.result.slice(0, 400) + (s.result.length > 400 ? "\n  ...(truncated)" : "");
        return `[${i + 1}] ${s.tool}(${JSON.stringify(s.params)})\n  → ${s.thought}\n  Result: ${result}`;
      }
      const keyLine = s.result.split("\n").find((l) => l.trim().length > 10) ?? s.result;
      return `[${i + 1}] ${s.tool} → ${keyLine.slice(0, 120)}`;
    })
    .join("\n\n");
}

// ─── System prompt ────────────────────────────────────────────────────────────

const TOOL_NAMES =
  "Tools: run_command(command) [kubectl/helm/network only — no aws CLI] | " +
  "aws_query(type,region?,max_results?,filter?) | aws_get(type,identifier,region?) | " +
  "ec2_exec(instance_id,command,region?) | cw_metrics(namespace,metric,dimensions?,since_hours?,period_minutes?,statistic?,region?) | " +
  "cw_logs(log_group,filter_pattern?,since_hours?,limit?,region?)\n" +
  "Parallel: use {\"calls\":[{\"tool\":\"...\",\"params\":{...}},{\"tool\":\"...\",\"params\":{...}}]} to run independent queries concurrently.";

function systemPrompt(question: string, awsRegion: string, steps: Step[], options: DebugOptions): string {
  const history = compressHistory(steps);
  const toolSection = steps.length === 0 ? buildToolCatalog() : TOOL_NAMES;

  // Extra context injected when called from the `debug` command
  const extraCtx: string[] = [];
  if (options.namespace)     extraCtx.push(`Kubernetes namespace: ${options.namespace}`);
  if (options.since)         extraCtx.push(`Look-back window: ${options.since}`);
  if (options.lokiUrl)       extraCtx.push(`Loki URL: ${options.lokiUrl} — query via run_command(curl)`);
  if (options.openSearchUrl) extraCtx.push(`OpenSearch URL: ${options.openSearchUrl} — query via run_command(curl)`);
  const extraSection = extraCtx.length > 0 ? `\nCONTEXT:\n${extraCtx.join("\n")}\n` : "";

  return `You are an expert SRE agent investigating a live infrastructure problem.
You have access to six tools. You decide WHAT to run at every step — no cases are pre-defined.
Think like a senior engineer: start broad, narrow down, follow evidence.

${toolSection}
${extraSection}
RESPONSE FORMAT — ONE valid JSON object, no markdown fences:

Single tool:   {"thought":"...","tool":"tool_name","params":{...},"done":false}
Parallel:      {"thought":"...","calls":[{"tool":"...","params":{...}},{...}],"done":false}
Conclusion:    {"thought":"...","done":true,"answer":"## Root Cause\\n...\\n## Fix It Now\\n1. ...\\n## Prevent Recurrence\\n1. ..."}

PROBLEM  : ${question}
REGION   : ${awsRegion}
TIME     : ${new Date().toISOString()}

INVESTIGATION HISTORY:
${history}

Your next action:`;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class DiagnoseAgent {
  constructor(private readonly bedrock: BedrockService) {}

  async run(question: string, awsRegion: string, options: DebugOptions = {}, credentials?: AwsCredentials): Promise<string> {
    console.log("");
    printBoxHeader(`Investigating · ${question.slice(0, 60)}`);
    console.log("");

    const ctx: ToolContext = { awsRegion, k8sContext: options.k8sContext, awsCredentials: credentials };
    const steps: Step[] = [];
    let finalAnswer = "";
    let stepNum = 0;

    while (stepNum < MAX_STEPS) {
      stepNum++;

      // ── Ask LLM what to do next ──────────────────────────────────────────
      const sp = new Spinner().start(`Step ${stepNum}/${MAX_STEPS}  ·  thinking…`);
      let raw: string;
      try {
        raw = await this.bedrock.complete(systemPrompt(question, awsRegion, steps, options), {
          maxTokens: 1024,
        });
      } catch (err) {
        sp.fail(`Step ${stepNum} — LLM error`);
        steps.push({ tool: "_error", params: {}, thought: "LLM call failed", result: String(err) });
        continue;
      }
      sp.fail(""); // clear spinner line

      // ── Parse response ────────────────────────────────────────────────────
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

      // ── Done? ─────────────────────────────────────────────────────────────
      if (parsed.done) {
        process.stdout.write(
          `\n  ${c.bold(c.green(sym.check))} ${c.dim(`[${stepNum}]`)} ${c.bold("conclusion")}  ` +
          `${c.dim(parsed.thought.slice(0, 80))}\n`,
        );
        finalAnswer = (parsed as { done: true; answer: string }).answer;
        break;
      }

      // ── Parallel calls ────────────────────────────────────────────────────
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
          const preview = result.split("\n")[0].slice(0, 100);
          process.stdout.write(`         ${c.bold(call.tool)}  ${c.dim(preview)}\n`);
          steps.push({ tool: call.tool, params: call.params, thought, result });
        }

        stepNum += calls.length - 1;
        continue;
      }

      // ── Single tool call ──────────────────────────────────────────────────
      const { tool, params, thought } = parsed as { done: false; tool: string; params: Record<string, string>; thought: string };

      process.stdout.write(
        `\n  ${c.bold(c.cyan(sym.dot))} ${c.dim(`[${stepNum}]`)} ${c.bold(tool)}` +
        `  ${c.dim("→")} ${thought.slice(0, 90)}\n`,
      );

      const result = await executeTool(tool, params, ctx);
      const preview = result.split("\n")[0].slice(0, 100);
      process.stdout.write(`         ${c.dim(preview)}\n`);

      steps.push({ tool, params, thought, result });
    }

    // ── If loop ended without conclusion, force a summary ────────────────────
    if (!finalAnswer) {
      const sp = new Spinner().start("Summarising findings…");
      try {
        const forcePrompt =
          systemPrompt(question, awsRegion, steps, options) +
          "\n\nYou have reached the step limit. Conclude now with done=true using all evidence gathered.";
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
    .map((s, i) => `**Step ${i + 1} [${s.tool}]:** ${s.result.slice(0, 300)}`)
    .join("\n\n");

  return `## Investigation Summary\n\nCompleted ${steps.length} investigation steps. Evidence gathered:\n\n${evidence}`;
}
