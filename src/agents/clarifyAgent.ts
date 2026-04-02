/**
 * clarifyAgent.ts
 *
 * Agentic ReAct loop for requirement gathering — mirrors the DiagnoseAgent pattern.
 *
 * The LLM drives the conversation: it decides what to ask, in what order, and
 * when it has enough information to conclude. No field names or question lists
 * are hard-coded here — the LLM reasons about what is missing.
 *
 * Loop continues until the LLM emits done:true with a fully enriched instruction
 * string that the planner can act on directly.
 */

import { BedrockService } from "../services/bedrockService";
import { parseJsonPayload } from "../utils/llm";
import { askText } from "../cli/prompts";
import { c, sym, Spinner } from "../utils/terminal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface QAPair {
  question: string;
  options?: string[];
  answer: string;
}

type LLMResponse =
  | { done: false;  thought: string; question: string; options?: string[]; allow_custom?: boolean }
  | { done: true;   thought: string; enriched_instruction: string; resource_types: string[] };

const MAX_QUESTIONS = 8;

// ─── System prompt ────────────────────────────────────────────────────────────

// Compact tool reference sent on subsequent steps to save tokens.
const TOOL_REF =
  "Tool: ask_user — {\"done\":false,\"thought\":\"...\",\"question\":\"...\",\"options\":[\"opt1\",\"opt2\"],\"allow_custom\":true}\n" +
  "Conclude: {\"done\":true,\"thought\":\"...\",\"enriched_instruction\":\"full detail\",\"resource_types\":[\"aws_instance\"]}";

function systemPrompt(instruction: string, history: QAPair[], step: number, contextFiles?: Record<string, string>): string {
  const historySection =
    history.length === 0
      ? "(no questions asked yet)"
      : history
          .map((h, i) => {
            const opts = h.options?.length ? `  [options: ${h.options.join(" | ")}]` : "";
            return `Q${i + 1}: ${h.question}${opts}\nA${i + 1}: ${h.answer}`;
          })
          .join("\n\n");

  // On step 0, emit full guidance; afterwards emit the compact ref to save tokens.
  const toolSection =
    step === 0
      ? [
          "RESPONSE FORMAT — ONE valid JSON object, no markdown fences:",
          "",
          "Ask a question:",
          '  {"done":false,"thought":"why I need this","question":"What instance type?","options":["t3.micro","t3.medium","m5.large","r6g.large"],"allow_custom":true}',
          "",
          "Conclude (when you have everything you need):",
          '  {"done":true,"thought":"I have all required details","enriched_instruction":"Create a t3.medium EC2 instance named web-server in ap-south-1 for the backend API service","resource_types":["aws_instance","aws_security_group"]}',
          "",
          "CLARIFICATION RULES:",
          "1. Ask ONE question at a time. Start with the most critical missing detail.",
          "2. Provide options (max 6, most common first) when applicable. Set allow_custom:true for free-form values.",
          "3. Always ask: resource name/identifier if absent.",
          "4. EC2 → need: name, instance_type. Ask about purpose only if completely ambiguous.",
          "5. RDS → need: name, engine (postgres/mysql/aurora-postgresql), instance_class, storage_gb.",
          "6. EKS → need: cluster_name, node_instance_type, node_count, k8s_version.",
          "7. VPC → need: name, cidr_block.",
          "8. S3 → need: bucket_name only.",
          "9. Lambda → need: function_name, runtime (nodejs20/python3.12/go1.x).",
          "10. Do NOT ask about tags, encryption defaults, monitoring — use sensible defaults.",
          "11. Do NOT ask about region if the original request or context already specifies it.",
          `12. Max ${MAX_QUESTIONS} questions — conclude as soon as you have all required fields.`,
          "13. enriched_instruction must be a complete single description with ALL gathered values filled in.",
          "14. resource_types must be valid Terraform aws_* type strings.",
        ].join("\n")
      : TOOL_REF;

  const contextSection =
    contextFiles && Object.keys(contextFiles).length > 0
      ? [
          "",
          "EXISTING TERRAFORM CONTEXT (already provisioned — do NOT re-ask for these values):",
          ...Object.entries(contextFiles)
            .slice(0, 4)
            .map(([name, content]) => `### ${name}\n${content.slice(0, 600)}`),
          "",
        ].join("\n")
      : "";

  return `You are an infrastructure requirements analyst. Gather exactly what is needed to generate a precise Terraform plan — nothing more.

${toolSection}
${contextSection}
ORIGINAL REQUEST: "${instruction}"

CONVERSATION SO FAR:
${historySection}

Your next action:`;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class ClarifyAgent {
  constructor(private readonly bedrock: BedrockService) {}

  /**
   * Run an interactive requirement-gathering loop.
   *
   * @param instruction   Raw user instruction, e.g. "create new ec2".
   * @param contextFiles  Existing Terraform files (for update flows) — the LLM
   *                      uses these to avoid asking about things already defined.
   * @returns             Enriched instruction string + detected resource types.
   */
  async run(
    instruction: string,
    contextFiles?: Record<string, string>,
  ): Promise<{ enrichedInstruction: string; resourceTypes: string[] }> {
    console.log("");

    const history: QAPair[] = [];

    for (let step = 0; step < MAX_QUESTIONS; step++) {
      // ── Ask the LLM what to do next ────────────────────────────────────────
      const sp = new Spinner().start(step === 0 ? "Analyzing request…" : "Thinking…");
      let raw: string;
      try {
        raw = await this.bedrock.complete(
          systemPrompt(instruction, history, step, contextFiles),
          { maxTokens: 512 },
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sp.fail(`LLM error: ${errMsg}`);
        throw err;
      }
      sp.fail(""); // clear spinner line

      // ── Parse response ────────────────────────────────────────────────────
      let parsed: LLMResponse;
      try {
        parsed = parseJsonPayload(raw, `clarify step ${step}`) as LLMResponse;
      } catch {
        process.stdout.write(
          `\n  ${c.dim(`[${step + 1}]`)} ${c.red("parse error")}  ${c.dim(raw.slice(0, 100))}\n`,
        );
        // Fall through — conclude with whatever we have
        break;
      }

      // ── Done? ─────────────────────────────────────────────────────────────
      if (parsed.done) {
        process.stdout.write(
          `\n  ${c.bold(c.green(sym.check))} ${c.dim("requirements gathered")}  ` +
            `${c.dim((parsed as { done: true; thought: string }).thought.slice(0, 80))}\n`,
        );
        return {
          enrichedInstruction: (parsed as { done: true; enriched_instruction: string }).enriched_instruction,
          resourceTypes: (parsed as { done: true; resource_types: string[] }).resource_types ?? [],
        };
      }

      // ── Ask the user ──────────────────────────────────────────────────────
      const { question, options, allow_custom } = parsed as {
        done: false;
        thought: string;
        question: string;
        options?: string[];
        allow_custom?: boolean;
      };

      process.stdout.write(`\n  ${c.bold(c.cyan(sym.dot))} ${c.bold(question)}\n`);

      let answer: string;

      if (options && options.length > 0) {
        options.forEach((opt, i) =>
          process.stdout.write(`    ${c.dim(String(i + 1) + ".")} ${opt}\n`),
        );
        const otherIdx = options.length + 1;
        if (allow_custom) {
          process.stdout.write(`    ${c.dim(String(otherIdx) + ".")} Other (enter custom value)\n`);
        }

        const raw = await askText(
          allow_custom ? `  Select (1-${otherIdx})` : `  Select (1-${options.length})`,
        );
        const selected = Number(raw.trim());

        if (Number.isInteger(selected) && selected >= 1 && selected <= options.length) {
          answer = options[selected - 1];
        } else if (allow_custom && Number.isInteger(selected) && selected === otherIdx) {
          answer = await askText("  Enter custom value");
        } else {
          // User typed a free-form answer — accept it as-is
          answer = raw.trim();
        }
      } else {
        answer = await askText("  Your answer");
      }

      process.stdout.write(
        `  ${c.green(sym.check)} ${c.dim(question)}  ${c.dim("→")}  ${c.cyan(answer)}\n`,
      );

      history.push({ question, options, answer });
    }

    // Fell through MAX_QUESTIONS without conclusion — use original instruction
    return { enrichedInstruction: instruction, resourceTypes: [] };
  }
}
