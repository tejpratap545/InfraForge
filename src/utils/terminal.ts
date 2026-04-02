/**
 * Terminal formatting utilities — Claude-style clean CLI output.
 * Respects NO_COLOR env var and non-TTY pipes (strips ANSI automatically).
 */

const TTY = process.stdout.isTTY === true && process.env["NO_COLOR"] == null;

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const esc = (code: string) => (s: string) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  bold:    esc("1"),
  dim:     esc("2"),
  cyan:    esc("36"),
  green:   esc("32"),
  yellow:  esc("33"),
  red:     esc("31"),
  blue:    esc("34"),
  magenta: esc("35"),
  gray:    esc("90"),
  white:   esc("97"),
};

// ─── Symbols (Unicode with ASCII fallback for non-TTY) ───────────────────────

export const sym = {
  check:   TTY ? "✓" : "+",
  cross:   TTY ? "✗" : "x",
  dot:     TTY ? "◆" : "*",
  circle:  TTY ? "○" : "-",
  warn:    TTY ? "⚠" : "!",
  arrow:   TTY ? "→" : "->",
  vbar:    TTY ? "│" : "|",
  hbar:    TTY ? "─" : "-",
  tee:     TTY ? "├" : "+",
  corner:  TTY ? "└" : "\\",
};

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private label = "";

  start(label: string): this {
    this.label = label;
    if (!TTY) {
      process.stdout.write(`  ${label}...\n`);
      return this;
    }
    this.frame = 0;
    this.timer = setInterval(() => {
      const f = c.cyan(FRAMES[this.frame++ % FRAMES.length]);
      process.stdout.write(`\r  ${f} ${c.dim(this.label)}`);
    }, 80);
    return this;
  }

  succeed(label?: string): void {
    this.clear();
    process.stdout.write(`  ${c.green(sym.check)} ${label ?? this.label}\n`);
  }

  fail(label?: string): void {
    this.clear();
    process.stdout.write(`  ${c.red(sym.cross)} ${label ?? this.label}\n`);
  }

  update(label: string): void {
    this.label = label;
  }

  private clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (TTY) process.stdout.write("\r\x1b[K");
  }
}

export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  doneLabel?: (result: T) => string,
): Promise<T> {
  const sp = new Spinner().start(label);
  try {
    const result = await fn();
    sp.succeed(doneLabel ? doneLabel(result) : label);
    return result;
  } catch (err) {
    sp.fail(label);
    throw err;
  }
}

// ─── Layout primitives ────────────────────────────────────────────────────────

/** Print a rounded box header. */
export function printBoxHeader(title: string): void {
  const inner = ` ${title} `;
  const width = Math.max(inner.length + 2, 52);
  const pad = inner.padEnd(width - 2);
  const top = "╭" + "─".repeat(width - 2) + "╮";
  const bot = "╰" + "─".repeat(width - 2) + "╯";
  console.log(c.cyan(top));
  console.log(c.cyan("│") + c.bold(pad) + c.cyan("│"));
  console.log(c.cyan(bot));
}

/** Print a dim horizontal rule. */
export function printRule(width = 58): void {
  console.log(c.dim(sym.hbar.repeat(width)));
}

/** Print a key→value row with aligned columns. */
export function printKV(
  key: string,
  value: string,
  opts: { indent?: number; keyWidth?: number; valueColor?: (s: string) => string } = {},
): void {
  const { indent = 4, keyWidth = 12, valueColor = (s) => s } = opts;
  const k = c.dim(key.padEnd(keyWidth));
  process.stdout.write(" ".repeat(indent) + k + "  " + valueColor(value) + "\n");
}

/** Print a step marker like [1/4]. */
export function printStep(n: number, total: number, label: string): void {
  const counter = c.dim(`[${n}/${total}]`);
  process.stdout.write(`\n${counter} ${c.bold(label)}\n`);
}

// ─── Discovery status rows ────────────────────────────────────────────────────

export function printFound(source: string, detail: string): void {
  const src = c.cyan(source.padEnd(14));
  process.stdout.write(`    ${c.green(sym.check)} ${src}  ${detail}\n`);
}

export function printSkipped(source: string, reason: string): void {
  const src = c.dim(source.padEnd(14));
  process.stdout.write(`    ${c.dim(sym.circle)} ${src}  ${c.dim(reason)}\n`);
}

// ─── Report renderer ──────────────────────────────────────────────────────────

/**
 * Renders the LLM markdown output into a styled terminal report.
 * Handles: ## headers, **bold**, - bullets, 1. lists, code blocks.
 */
export function renderReport(text: unknown): string {
  // If LLM returned answer as a JSON object (e.g. {"## Root Cause": "..."}),
  // flatten it into a markdown string instead of dumping raw JSON.
  let safe: string;
  if (typeof text === "string") {
    safe = text;
  } else if (text !== null && typeof text === "object" && !Array.isArray(text)) {
    safe = Object.entries(text as Record<string, unknown>)
      .map(([k, v]) => `${k}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)
      .join("\n\n");
  } else {
    safe = JSON.stringify(text, null, 2) ?? String(text);
  }
  const lines = safe.split("\n");
  const out: string[] = [""];

  let inCode = false;

  for (const raw of lines) {
    const line = raw;

    // ── Code fences
    if (line.startsWith("```")) {
      inCode = !inCode;
      if (inCode)  out.push(c.dim("    ┌────────────────────────────────────"));
      else         out.push(c.dim("    └────────────────────────────────────"));
      continue;
    }
    if (inCode) {
      out.push("    " + c.yellow(line));
      continue;
    }

    // ── Section headers  ##
    if (/^##\s+/.test(line)) {
      const title = line.replace(/^##\s+/, "");
      out.push("");
      out.push("  " + c.bold(c.cyan(title)));
      out.push("  " + c.dim(sym.hbar.repeat(Math.min(title.length + 2, 54))));
      continue;
    }

    // ── Bold+italic key line:  **key:** value
    if (/^\*\*(.+?)\*\*(.*)/.test(line)) {
      const styled = line.replace(/\*\*(.+?)\*\*/g, (_, inner) => c.bold(inner));
      out.push("  " + styled);
      continue;
    }

    // ── Numbered list items: "1. ..."
    const numMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      const [, n, rest] = numMatch;
      const decorated = applyInline(rest);
      out.push(`  ${c.cyan(c.bold(n + "."))} ${decorated}`);
      continue;
    }

    // ── Bullet list items: "- ..."
    if (/^- /.test(line)) {
      const rest = applyInline(line.slice(2));
      out.push(`    ${c.dim("·")} ${rest}`);
      continue;
    }

    // ── Horizontal rules
    if (/^[-─]{4,}$/.test(line.trim())) {
      out.push(c.dim(sym.hbar.repeat(58)));
      continue;
    }

    // ── Empty line
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // ── Regular paragraph
    out.push("  " + applyInline(line));
  }

  return out.join("\n");
}

/** Apply inline markdown (**bold**) to a string. */
function applyInline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, (_, inner) => c.bold(inner));
}

// ─── Urgency badge ────────────────────────────────────────────────────────────

export function urgencyBadge(urgency: string): string {
  switch (urgency.toLowerCase()) {
    case "critical": return c.bold(c.red("● CRITICAL"));
    case "high":     return c.bold(c.yellow("● HIGH"));
    case "medium":   return c.yellow("● MEDIUM");
    default:         return c.dim("● LOW");
  }
}

export function severityColor(severity: string): (s: string) => string {
  switch (severity.toLowerCase()) {
    case "critical": return c.red;
    case "error":    return c.yellow;
    case "warn":     return c.yellow;
    default:         return c.dim;
  }
}

// ─── Output block ─────────────────────────────────────────────────────────────

/**
 * Print a labeled block of preformatted output (terraform logs, etc.)
 * Indents every line and wraps in dim ruled borders.
 */
export function printOutputBlock(title: string, content: string): void {
  if (!content?.trim()) return;
  const rule = c.dim(sym.hbar.repeat(54));
  console.log(`\n  ${c.dim(sym.hbar.repeat(2))} ${c.bold(title)} ${rule}`);
  for (const line of content.trim().split("\n")) {
    console.log("    " + c.dim(line));
  }
  console.log(c.dim("  " + sym.hbar.repeat(58)));
}

// ─── Coverage row (debug / diagnose) ─────────────────────────────────────────

export function printCoverageFound(label: string, detail: string): void {
  process.stdout.write(`    ${c.green(sym.check)} ${c.bold(label.padEnd(18))}  ${detail}\n`);
}

export function printCoverageEmpty(label: string, detail: string): void {
  process.stdout.write(`    ${c.dim(sym.circle)} ${c.dim(label.padEnd(18))}  ${c.dim(detail)}\n`);
}

// ─── Elapsed helper ───────────────────────────────────────────────────────────

export function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ─── Telemetry panel ──────────────────────────────────────────────────────────

import type { TelemetryCollector } from "../services/telemetryCollector";
import { estimateCost, pricing } from "../services/telemetryCollector";

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(usd: number): string {
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

export function printTelemetry(tel: TelemetryCollector, modeLabel: string, modelLabel: string): void {
  console.log("");
  printBoxHeader("Run Telemetry");
  console.log("");

  // ── Overview ──
  const totalMs = tel.elapsedMs;
  printKV("Session",  c.dim(tel.runId),                        { keyWidth: 12 });
  printKV("Mode",     `${c.bold(modeLabel)}  ${c.dim("·")}  ${c.bold(modelLabel)}`, { keyWidth: 12 });
  printKV("Elapsed",  c.cyan(fmtMs(totalMs)),                   { keyWidth: 12 });
  printKV("LLM calls", c.bold(String(tel.callCount)),           { keyWidth: 12 });
  console.log("");

  // ── Token usage ──
  if (tel.totalTokens > 0) {
    console.log(`  ${c.bold(c.cyan(sym.dot))}  ${c.bold("Token Usage")}`);
    console.log("");
    printKV("Input",   `${c.bold(fmtTokens(tel.totalInputTokens))}  ${c.dim("tokens")}`,  { keyWidth: 12, indent: 6 });
    printKV("Output",  `${c.bold(fmtTokens(tel.totalOutputTokens))}  ${c.dim("tokens")}`, { keyWidth: 12, indent: 6 });
    printKV("Total",   `${c.bold(fmtTokens(tel.totalTokens))}  ${c.dim("tokens")}`,       { keyWidth: 12, indent: 6 });
    console.log("");
  }

  // ── Per-call breakdown ──
  if (tel.calls.length > 0) {
    console.log(`  ${c.bold(c.cyan(sym.dot))}  ${c.bold("LLM Call Breakdown")}`);
    console.log("");
    tel.calls.forEach((r, i) => {
      const inTok   = fmtTokens(r.inputTokens).padStart(7);
      const outTok  = fmtTokens(r.outputTokens).padStart(7);
      const lat     = fmtMs(r.latencyMs).padStart(7);
      const callCost = estimateCost(r.modelId, r.inputTokens, r.outputTokens);
      const idx     = c.dim(`#${String(i + 1).padStart(2)}`);
      const costStr = tel.totalTokens > 0 ? `  ${c.dim(fmtCost(callCost))}` : "";
      process.stdout.write(
        `    ${idx}   ${c.dim("in")} ${c.cyan(inTok)}  ${c.dim("out")} ${c.cyan(outTok)}  ${c.dim("lat")} ${c.yellow(lat)}${costStr}\n`,
      );
    });
    console.log("");
  }

  // ── Cost estimate ──
  if (tel.totalTokens > 0) {
    const modelId   = tel.primaryModelId;
    const p         = pricing(modelId);
    const total     = tel.totalCost();
    const inCost    = (tel.totalInputTokens  / 1_000_000) * p.in;
    const outCost   = (tel.totalOutputTokens / 1_000_000) * p.out;

    console.log(`  ${c.bold(c.cyan(sym.dot))}  ${c.bold("Estimated Cost")}  ${c.dim("(on-demand Bedrock pricing, approximate)")}`);
    console.log("");
    printKV("Input",   `${fmtCost(inCost)}  ${c.dim(`${fmtTokens(tel.totalInputTokens)} × $${p.in}/M`)}`,   { keyWidth: 12, indent: 6 });
    printKV("Output",  `${fmtCost(outCost)}  ${c.dim(`${fmtTokens(tel.totalOutputTokens)} × $${p.out}/M`)}`, { keyWidth: 12, indent: 6 });
    printKV("Total",   c.bold(c.green(fmtCost(total))),                                                       { keyWidth: 12, indent: 6 });
    console.log("");
  }

  printRule();
}
