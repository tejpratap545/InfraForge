/**
 * Interactive session — arrow-key mode + model picker, then a persistent
 * run loop. Launched when `infra` is called with no subcommand.
 */
import * as readline from "node:readline";
import { v4 as uuidv4 } from "uuid";
import { TenantContext } from "../types";
import { InfraWorkflow } from "../workflows/infraWorkflow";
import { TelemetryCollector } from "../services/telemetryCollector";
import { c, sym, printBoxHeader, printKV, printTelemetry } from "../utils/terminal";

// ─── Menu data ────────────────────────────────────────────────────────────────

interface MenuItem {
  id: string;
  label: string;
  desc: string;
}

const MODES: MenuItem[] = [
  { id: "diagnose", label: "diagnose", desc: "Ask a plain-English question — auto-discovers everything" },
  { id: "debug",    label: "debug",    desc: "Collect signals for a specific service name" },
  { id: "ask",      label: "ask",      desc: "Query your live AWS inventory" },
  { id: "create",   label: "create",   desc: "Generate and apply Terraform infrastructure" },
  { id: "plan",     label: "plan",     desc: "Dry-run plan — no changes applied" },
  { id: "apply",    label: "apply",    desc: "Apply Terraform with confirmation gate" },
];

const REGIONS: MenuItem[] = [
  { id: "us-east-1",      label: "us-east-1",      desc: "US East — N. Virginia  (default)" },
  { id: "us-east-2",      label: "us-east-2",      desc: "US East — Ohio" },
  { id: "us-west-1",      label: "us-west-1",      desc: "US West — N. California" },
  { id: "us-west-2",      label: "us-west-2",      desc: "US West — Oregon" },
  { id: "ap-south-1",     label: "ap-south-1",     desc: "Asia Pacific — Mumbai" },
  { id: "ap-southeast-1", label: "ap-southeast-1", desc: "Asia Pacific — Singapore" },
  { id: "ap-southeast-2", label: "ap-southeast-2", desc: "Asia Pacific — Sydney" },
  { id: "ap-northeast-1", label: "ap-northeast-1", desc: "Asia Pacific — Tokyo" },
  { id: "ap-northeast-2", label: "ap-northeast-2", desc: "Asia Pacific — Seoul" },
  { id: "eu-west-1",      label: "eu-west-1",      desc: "Europe — Ireland" },
  { id: "eu-west-2",      label: "eu-west-2",      desc: "Europe — London" },
  { id: "eu-central-1",   label: "eu-central-1",   desc: "Europe — Frankfurt" },
  { id: "ca-central-1",   label: "ca-central-1",   desc: "Canada — Central" },
  { id: "sa-east-1",      label: "sa-east-1",      desc: "South America — São Paulo" },
];

const MODELS: MenuItem[] = [
  {
    id:    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Claude Sonnet 4.6",
    desc:  "Balanced speed & intelligence — recommended",
  },
  {
    id:    "global.anthropic.claude-opus-4-5-20251101-v1:0",
    label: "Claude Opus 4.6",
    desc:  "Maximum reasoning capability",
  },
  {
    id:    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    label: "Claude Haiku 4.5",
    desc:  "Fastest, lowest cost",
  },
  {
    id:    "mistral.mistral-large-3-675b-instruct",
    label: "Mistral Large 2",
    desc:  "Fallback / open-source alternative",
  },
];

// ─── Arrow-key selection menu ────────────────────────────────────────────────

const LABEL_WIDTH = 18;

function renderMenuLines(prompt: string, items: MenuItem[], selected: number): string[] {
  const lines: string[] = [];
  lines.push(""); // blank before title
  lines.push(`  ${c.bold(c.cyan(sym.dot))}  ${c.bold(prompt)}`);
  lines.push(""); // blank after title
  for (let i = 0; i < items.length; i++) {
    const active = i === selected;
    const cursor = active ? c.cyan("❯") : " ";
    const label  = active
      ? c.bold(c.white(items[i].label.padEnd(LABEL_WIDTH)))
      : c.dim(items[i].label.padEnd(LABEL_WIDTH));
    const desc = active ? c.dim(items[i].desc) : c.dim(items[i].desc);
    lines.push(`    ${cursor}  ${label}  ${desc}`);
  }
  lines.push(""); // blank
  lines.push(c.dim("  ↑↓  navigate    Enter  select    Ctrl+C  exit"));
  return lines;
}

async function selectMenu(prompt: string, items: MenuItem[]): Promise<MenuItem> {
  return new Promise((resolve, reject) => {
    let selected = 0;

    // Hide cursor while navigating.
    process.stdout.write("\x1b[?25l");

    // Initial draw.
    const lines = renderMenuLines(prompt, items, selected);
    for (const l of lines) process.stdout.write(l + "\n");

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    function redraw() {
      const newLines = renderMenuLines(prompt, items, selected);
      // Move cursor up to the start of the menu block.
      process.stdout.write(`\x1b[${newLines.length}A`);
      for (const l of newLines) {
        process.stdout.write("\x1b[2K\x1b[0G" + l + "\n");
      }
    }

    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?25h"); // restore cursor
    }

    function onKey(_str: string, key: readline.Key) {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }
      if (key.name === "up") {
        selected = (selected - 1 + items.length) % items.length;
        redraw();
      } else if (key.name === "down") {
        selected = (selected + 1) % items.length;
        redraw();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        // Print the confirmed selection and move on.
        process.stdout.write(
          `\n  ${c.green(sym.check)}  ${c.bold(items[selected].label)}  ${c.dim(items[selected].desc)}\n`,
        );
        resolve(items[selected]);
      }
    }

    process.stdin.on("keypress", onKey);

    // Safety: resolve on uncaught errors.
    process.stdin.once("error", reject);
  });
}

// ─── Single-line text input ───────────────────────────────────────────────────

async function textInput(prompt: string, hint?: string): Promise<string> {
  if (hint) process.stdout.write(c.dim(`  ${hint}\n`));
  process.stdout.write(`\n  ${c.bold(c.cyan(sym.dot))}  ${c.bold(prompt)}\n\n`);
  process.stdout.write(`  ${c.cyan("›")} `);

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    // Guard against the race: rl.close() emits "close" synchronously inside
    // the "line" handler, before resolve(line) has a chance to run.
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line.trim());
    });
    rl.once("close", () => { if (!done) resolve(""); });
  });
}

// ─── Execution dispatcher ─────────────────────────────────────────────────────

async function executeMode(
  workflow: InfraWorkflow,
  modeId: string,
  input: string,
  tenant: TenantContext,
): Promise<void> {
  switch (modeId) {
    case "diagnose": await workflow.diagnose(input, tenant); break;
    case "debug":    await workflow.debug(input, tenant, {}); break;
    case "ask":      await workflow.ask(input, tenant); break;
    case "create":   await workflow.createOrUpdate(input, tenant); break;
    case "plan":     await workflow.planOnly(input, tenant); break;
    case "apply":    await workflow.applyExisting(input, tenant); break;
    default: throw new Error(`Unknown mode: ${modeId}`);
  }
}

function getModePrompt(modeId: string): string {
  switch (modeId) {
    case "diagnose": return "Your question";
    case "debug":    return "Service name";
    case "ask":      return "Your question";
    case "create":
    case "apply":
    case "plan":     return "Describe the infrastructure";
    default:         return "Input";
  }
}

function getModeHint(modeId: string): string | undefined {
  switch (modeId) {
    case "diagnose": return 'e.g. "why is mimir crashing?"  or  "payment service is throwing 503s"';
    case "debug":    return 'e.g. checkout-api  ·  Advanced options available via  infra debug --help';
    case "ask":      return 'e.g. "how many EC2 instances do I have in us-east-1?"';
    case "create":   return 'e.g. "deploy an EKS cluster with 3 nodes in us-east-1"';
    case "plan":     return 'e.g. "create an RDS PostgreSQL 15 instance"';
    case "apply":    return 'e.g. "add a Lambda function with S3 trigger"';
    default:         return undefined;
  }
}

// ─── Continue prompt ──────────────────────────────────────────────────────────

async function promptContinue(): Promise<boolean> {
  process.stdout.write(
    `\n  ${c.dim("Press")} ${c.cyan("Enter")} ${c.dim("for a new query    ")}${c.dim("Ctrl+C")} ${c.dim("to exit")}\n\n  ${c.cyan("›")} `,
  );
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let done = false;
    rl.once("line", () => {
      done = true;
      rl.close();
      process.stdin.resume();
      resolve(true);
    });
    rl.once("close", () => {
      if (!done) {
        process.stdin.resume();
        resolve(false);
      }
    });
  });
}

// ─── Session header ───────────────────────────────────────────────────────────

function printSessionHeader(tenant: TenantContext): void {
  console.log("");
  printBoxHeader("infra-copilot  ·  v1.0.0");
  console.log("");
  printKV("Tenant",  tenant.tenantId,        { keyWidth: 10 });
  printKV("User",    tenant.userId,           { keyWidth: 10 });
  printKV("Region",  c.cyan(tenant.awsRegion), { keyWidth: 10 });
  printKV("Tier",    c.dim(tenant.subscriptionTier), { keyWidth: 10 });
  console.log("");
}

// ─── Main session loop ────────────────────────────────────────────────────────

export async function runInteractiveSession(
  tenant: TenantContext,
  makeWorkflowFn: (region: string, modelId: string, telemetry: TelemetryCollector) => InfraWorkflow,
): Promise<void> {
  printSessionHeader(tenant);

  // Keep the user's chosen mode/model for the whole interactive session.
  const mode = await selectMenu("Mode", MODES);
  const model = await selectMenu("Model", MODELS);

  console.log("");
  printKV("Mode",  c.bold(mode.label),  { keyWidth: 8 });
  printKV("Model", c.bold(model.label), { keyWidth: 8 });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 1. Input.
    const input = await textInput(getModePrompt(mode.id), getModeHint(mode.id));
    if (!input) {
      console.log(c.dim("  (empty input — waiting for another query)\n"));
      continue;
    }

    // 2. Execute with per-run telemetry collector.
    const telemetry = new TelemetryCollector(uuidv4());
    const workflow  = makeWorkflowFn(tenant.awsRegion, model.id, telemetry);

    try {
      await executeMode(workflow, mode.id, input, tenant);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ${c.red(sym.cross)} ${c.red("Error:")}  ${msg}`);
    }

    // 3. Telemetry panel.
    printTelemetry(telemetry, mode.label, model.label);

    // 4. Loop.
    const again = await promptContinue();
    if (!again) break;
    console.log("");
  }

  console.log(`\n  ${c.dim("Goodbye.")}\n`);
}
