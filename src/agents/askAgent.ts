/**
 * askAgent.ts
 *
 * Agentic ReAct loop for AWS inventory / metrics / Kubernetes questions.
 * Mirrors the DiagnoseAgent pattern exactly.
 *
 * The LLM decides at every step what to query — no targets or question-type
 * classification is pre-computed. The loop continues until the LLM has enough
 * data to answer confidently and declares done:true.
 *
 * Tools available: run_command · aws_query · aws_get · cw_metrics · cw_logs
 * (same catalog as DiagnoseAgent — parallel fan-out supported)
 */

import { BedrockService } from "../services/bedrockService";
import { executeTool, buildToolCatalog, ToolContext } from "../services/diagnoseTools";
import { parseJsonPayload } from "../utils/llm";
import { c, sym, Spinner, printBoxHeader, renderReport } from "../utils/terminal";
import type { AwsCredentials } from "../types";

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
  | { done: false; thought: string; tool: string;      params: Record<string, string>; calls?: never }
  | { done: false; thought: string; calls: ToolCall[]; tool?: never; params?: never }
  | { done: true;  thought: string; answer: string };

const MAX_STEPS = 15;

// ─── History compression ──────────────────────────────────────────────────────

function compressHistory(steps: Step[]): string {
  if (steps.length === 0) return "(no queries yet)";
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
  "cw_metrics(namespace,metric,dimensions?,since_hours?,period_minutes?,statistic?,region?) | " +
  "cw_logs(log_group,filter_pattern?,since_hours?,limit?,region?)\n" +
  "Parallel: use {\"calls\":[{\"tool\":\"...\",\"params\":{...}},{\"tool\":\"...\",\"params\":{...}}]} to run independent queries concurrently.";

function systemPrompt(question: string, awsRegion: string, steps: Step[]): string {
  const history = compressHistory(steps);
  const toolSection = steps.length === 0 ? buildToolCatalog() : TOOL_NAMES;

  return `You are an expert AWS cloud analyst. Answer the user's question by querying live AWS data.
Think like a cloud architect: pick the most relevant data source, fetch just enough to answer accurately.

${toolSection}

RESPONSE FORMAT — ONE valid JSON object, no markdown fences:

Single tool:   {"thought":"...","tool":"tool_name","params":{...},"done":false}
Parallel:      {"thought":"...","calls":[{"tool":"...","params":{...}},{...}],"done":false}
Answer:        {"thought":"...","done":true,"answer":"Direct answer here with specific values, counts, and resource names from the data"}

RULES:
- Use aws_query/aws_get for resource inventory questions (EC2, EKS, RDS, S3, VPC, IAM, ALB…).
- Use cw_metrics for performance / health questions (CPU, memory, errors, latency, connections).
- Use cw_logs for log-based questions (errors, recent events, request logs).
- Use run_command (kubectl) for in-cluster Kubernetes questions.
- Fetch in parallel when multiple independent data sources are needed.
- Conclude as soon as you have enough to answer — don't over-query.
- answer must be specific: include names, IDs, counts, metric values from the actual data.

QUESTION : ${question}
REGION   : ${awsRegion}
TIME     : ${new Date().toISOString()}

QUERY HISTORY:
${history}

Your next action:`;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class AskAgent {
  constructor(private readonly bedrock: BedrockService) {}

  async run(question: string, awsRegion: string, k8sContext?: string, credentials?: AwsCredentials): Promise<string> {
    console.log("");
    printBoxHeader(`Asking · ${question.slice(0, 60)}`);
    console.log("");

    const ctx: ToolContext = { awsRegion, k8sContext, awsCredentials: credentials };
    const steps: Step[] = [];
    let finalAnswer = "";
    let stepNum = 0;

    while (stepNum < MAX_STEPS) {
      stepNum++;

      // ── Ask LLM what to query next ───────────────────────────────────────
      const sp = new Spinner().start(`Step ${stepNum}/${MAX_STEPS}  ·  thinking…`);
      let raw: string;
      try {
        raw = await this.bedrock.complete(systemPrompt(question, awsRegion, steps), { maxTokens: 1024 });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sp.fail(`Step ${stepNum} — LLM error: ${errMsg}`);
        throw err;
      }
      sp.fail(""); // clear spinner line

      // ── Parse ─────────────────────────────────────────────────────────────
      let parsed: LLMResponse;
      try {
        parsed = parseJsonPayload(raw, `ask step ${stepNum}`) as LLMResponse;
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
          `\n  ${c.bold(c.green(sym.check))} ${c.dim(`[${stepNum}]`)} ${c.bold("answer ready")}  ` +
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

    // ── Force answer if loop exhausted ───────────────────────────────────────
    if (!finalAnswer) {
      const sp = new Spinner().start("Synthesising answer…");
      try {
        const forcePrompt =
          systemPrompt(question, awsRegion, steps) +
          "\n\nYou have reached the step limit. Answer now with done:true using all data gathered so far.";
        const raw2 = await this.bedrock.complete(forcePrompt, { maxTokens: 2048 });
        const p2 = parseJsonPayload(raw2, "ask force-answer") as LLMResponse;
        finalAnswer = p2.done
          ? (p2 as { done: true; answer: string }).answer
          : buildFallbackAnswer(steps);
        sp.succeed("Answer synthesised");
      } catch {
        sp.fail("Could not synthesise answer");
        finalAnswer = buildFallbackAnswer(steps);
      }
    }

    console.log("");
    return renderReport(finalAnswer);
  }
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function buildFallbackAnswer(steps: Step[]): string {
  const evidence = steps
    .filter((s) => !s.tool.startsWith("_"))
    .map((s) => `**[${s.tool}]:** ${s.result.slice(0, 300)}`)
    .join("\n\n");
  return `## Data Collected\n\n${evidence || "No data was successfully retrieved."}`;
}
