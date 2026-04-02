/**
 * Interactive session — arrow-key mode + model + reasoning picker,
 * then a persistent run loop.
 *
 * Commands:
 *   ask          — Q&A about live AWS/K8s environment
 *   diagnose     — Deep incident investigation
 *   plan create  — Generate and apply new infrastructure
 *   plan dry-run — Show what would change, no execution
 *   plan apply   — Apply a change (new or patch existing TF dir)
 *
 * Slash commands at the prompt:
 *   /mode   — re-pick mode
 *   /model  — re-pick LLM model
 *   /switch — re-pick both
 *   /exit   — quit
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
  { id: "ask",         label: "ask",          desc: "Q&A about your live AWS / K8s environment" },
  { id: "diagnose",    label: "diagnose",      desc: "Deep incident investigation — root cause analysis" },
  { id: "plan:create", label: "plan create",   desc: "Generate and apply new infrastructure" },
  { id: "plan:dryrun", label: "plan dry-run",  desc: "Show what would change — no execution" },
  { id: "plan:apply",  label: "plan apply",    desc: "Apply a change (new or patch existing Terraform dir)" },
];

const REASONING: MenuItem[] = [
  { id: "quick",    label: "quick",    desc: "Fast — 5/8 steps   · inventory checks, simple issues" },
  { id: "standard", label: "standard", desc: "Balanced — 15/25 steps  · most incidents  (default)" },
  { id: "deep",     label: "deep",     desc: "Thorough — 25/40 steps  · complex failures, cert/ingress" },
];

const ENGINE: MenuItem[] = [
  { id: "terraform", label: "terraform", desc: "HCL files → terraform plan → terraform apply  (default)" },
  { id: "aws",       label: "aws",       desc: "Cloud Control API — fast provisioning, no state file" },
];

const REGIONS: MenuItem[] = [
  { id: "ap-south-1",     label: "ap-south-1",     desc: "Asia Pacific — Mumbai  (default)" },
  { id: "us-east-1",      label: "us-east-1",      desc: "US East — N. Virginia" },
  { id: "us-east-2",      label: "us-east-2",      desc: "US East — Ohio" },
  { id: "us-west-1",      label: "us-west-1",      desc: "US West — N. California" },
  { id: "us-west-2",      label: "us-west-2",      desc: "US West — Oregon" },
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

export { REGIONS };

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

// ─── Arrow-key selection menu ─────────────────────────────────────────────────

const LABEL_WIDTH = 18;

function renderMenuLines(prompt: string, items: MenuItem[], selected: number): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${c.bold(c.cyan(sym.dot))}  ${c.bold(prompt)}`);
  lines.push("");
  for (let i = 0; i < items.length; i++) {
    const active = i === selected;
    const cursor = active ? c.cyan("❯") : " ";
    const label  = active
      ? c.bold(c.white(items[i].label.padEnd(LABEL_WIDTH)))
      : c.dim(items[i].label.padEnd(LABEL_WIDTH));
    const desc = c.dim(items[i].desc);
    lines.push(`    ${cursor}  ${label}  ${desc}`);
  }
  lines.push("");
  lines.push(c.dim("  ↑↓  navigate    Enter  select    Esc/←  back    Ctrl+C  exit"));
  return lines;
}

async function selectMenu(prompt: string, items: MenuItem[], canGoBack = false): Promise<MenuItem | null> {
  return new Promise((resolve, reject) => {
    let selected = 0;
    process.stdout.write("\x1b[?25l");

    const lines = renderMenuLines(prompt, items, selected);
    for (const l of lines) process.stdout.write(l + "\n");

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.setRawMode(true);
    }

    function redraw() {
      const newLines = renderMenuLines(prompt, items, selected);
      process.stdout.write(`\x1b[${newLines.length}A`);
      for (const l of newLines) {
        process.stdout.write("\x1b[2K\x1b[0G" + l + "\n");
      }
    }

    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?25h");
    }

    function onKey(_str: string, key: readline.Key) {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }
      if (key.name === "escape" || key.name === "left" || key.name === "backspace") {
        if (canGoBack) { cleanup(); process.stdout.write("\n"); resolve(null); }
        return;
      }
      if (key.name === "up") {
        selected = (selected - 1 + items.length) % items.length;
        redraw();
      } else if (key.name === "down") {
        selected = (selected + 1) % items.length;
        redraw();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write(
          `\n  ${c.green(sym.check)}  ${c.bold(items[selected].label)}  ${c.dim(items[selected].desc)}\n`,
        );
        resolve(items[selected]);
      }
    }

    process.stdin.on("keypress", onKey);
    process.stdin.once("error", reject);
  });
}

// ─── Single-line text input ───────────────────────────────────────────────────

async function textInput(prompt: string, hint?: string): Promise<string> {
  if (hint) process.stdout.write(c.dim(`  ${hint}\n`));
  process.stdout.write(`\n  ${c.bold(c.cyan(sym.dot))}  ${c.bold(prompt)}\n\n`);
  process.stdout.write(`  ${c.cyan("›")} `);

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let done = false;
    rl.once("line", (line) => { done = true; rl.close(); resolve(line.trim()); });
    rl.once("close", () => { if (!done) resolve(""); });
  });
}

// ─── Execution dispatcher ─────────────────────────────────────────────────────

async function executeMode(
  workflow: InfraWorkflow,
  modeId: string,
  engine: string,
  reasoning: string,
  input: string,
  tenant: TenantContext,
): Promise<void> {
  const r = reasoning as "quick" | "standard" | "deep";
  switch (modeId) {
    case "ask":
      await workflow.ask(input, tenant, undefined, r);
      break;
    case "diagnose":
      await workflow.diagnose(input, tenant, undefined, r);
      break;
    case "plan:create":
      if (engine === "aws") {
        await workflow.createWithAwsSdk(input, tenant);
      } else {
        await workflow.createOrUpdate(input, tenant);
      }
      break;
    case "plan:dryrun":
      await workflow.planOnly(input, tenant);
      break;
    case "plan:apply":
      await workflow.applyExisting(input, tenant);
      break;
    default:
      throw new Error(`Unknown mode: ${modeId}`);
  }
}

function getModePrompt(modeId: string): string {
  switch (modeId) {
    case "ask":         return "Your question";
    case "diagnose":    return "What are you investigating?";
    case "plan:create": return "Describe the infrastructure to create";
    case "plan:dryrun": return "Describe the change (dry run)";
    case "plan:apply":  return "Describe the change to apply";
    default:            return "Input";
  }
}

function getModeHint(mode: MenuItem, model: MenuItem, reasoning: MenuItem): string {
  const status    = `${c.dim("mode:")} ${c.cyan(mode.label)}  ${c.dim("model:")} ${c.cyan(model.label)}  ${c.dim("reasoning:")} ${c.cyan(reasoning.label)}`;
  const switchHint = c.dim(`  /mode · /model · /switch to change    /exit to quit`);

  let example = "";
  switch (mode.id) {
    case "ask":         example = 'e.g. "how many EKS clusters in ap-south-1?"'; break;
    case "diagnose":    example = 'e.g. "why is mimir crashing?"'; break;
    case "plan:create": example = 'e.g. "create RDS PostgreSQL t3.medium"'; break;
    case "plan:dryrun": example = 'e.g. "add node group to EKS"'; break;
    case "plan:apply":  example = 'e.g. "increase ECS replica count to 4"'; break;
  }

  return `${status}   ${c.dim(example)}\n${switchHint}`;
}

// ─── Mode + model + reasoning picker (with back-navigation) ──────────────────

async function pickSession(): Promise<{ mode: MenuItem; model: MenuItem; reasoning: MenuItem; engine: MenuItem }> {
  while (true) {
    const mode = await selectMenu("Mode", MODES, false);
    if (!mode) continue;

    // Plan commands need an engine selection
    let engine = ENGINE[0]; // default terraform
    if (mode.id === "plan:create" || mode.id === "plan:apply") {
      while (true) {
        const picked = await selectMenu("Engine", ENGINE, true);
        if (!picked) break; // go back to mode
        engine = picked;
        break;
      }
      // If user backed out of engine, re-pick mode
      if (engine === ENGINE[0] && mode.id === "plan:apply") { /* ok, terraform default */ }
    }

    while (true) {
      const reasoning = await selectMenu("Reasoning depth", REASONING, true);
      if (!reasoning) break; // go back to mode

      while (true) {
        const model = await selectMenu("Model", MODELS, true);
        if (!model) break; // go back to reasoning

        return { mode, model, reasoning, engine };
      }
    }
  }
}

// ─── Session header ───────────────────────────────────────────────────────────

function printSessionHeader(tenant: TenantContext): void {
  console.log("");
  printBoxHeader("infra-copilot  ·  v1.0.0");
  console.log("");
  printKV("Tenant", tenant.tenantId,              { keyWidth: 10 });
  printKV("User",   tenant.userId,                { keyWidth: 10 });
  printKV("Region", c.cyan(tenant.awsRegion),     { keyWidth: 10 });
  printKV("Tier",   c.dim(tenant.subscriptionTier), { keyWidth: 10 });
  console.log("");
}

// ─── Main session loop ────────────────────────────────────────────────────────

export async function runInteractiveSession(
  tenant: TenantContext,
  makeWorkflowFn: (region: string, modelId: string, telemetry: TelemetryCollector) => InfraWorkflow,
): Promise<void> {
  printSessionHeader(tenant);

  let { mode, model, reasoning, engine } = await pickSession();

  console.log("");
  printKV("Mode",      c.bold(mode.label),      { keyWidth: 12 });
  printKV("Reasoning", c.bold(reasoning.label), { keyWidth: 12 });
  printKV("Model",     c.bold(model.label),      { keyWidth: 12 });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const input = await textInput(getModePrompt(mode.id), getModeHint(mode, model, reasoning));

    if (input === "/exit" || input === "/quit") break;

    if (input === "/mode" || input === "/m") {
      const picked = await selectMenu("Mode", MODES, false);
      if (picked) { mode = picked; printKV("Mode", c.bold(mode.label), { keyWidth: 12 }); }
      continue;
    }
    if (input === "/model" || input === "/llm") {
      const picked = await selectMenu("Model", MODELS, true);
      if (picked) { model = picked; printKV("Model", c.bold(model.label), { keyWidth: 12 }); }
      continue;
    }
    if (input === "/switch" || input === "/s") {
      const picked = await pickSession();
      mode = picked.mode; model = picked.model; reasoning = picked.reasoning; engine = picked.engine;
      printKV("Mode",      c.bold(mode.label),      { keyWidth: 12 });
      printKV("Reasoning", c.bold(reasoning.label), { keyWidth: 12 });
      printKV("Model",     c.bold(model.label),      { keyWidth: 12 });
      continue;
    }

    if (!input) {
      console.log(c.dim("  (empty input — waiting for another query)\n"));
      continue;
    }

    const telemetry = new TelemetryCollector(uuidv4());
    const workflow  = makeWorkflowFn(tenant.awsRegion, model.id, telemetry);

    try {
      await executeMode(workflow, mode.id, engine.id, reasoning.id, input, tenant);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ${c.red(sym.cross)} ${c.red("Error:")}  ${msg}`);
    }

    console.log(`\n  ${c.dim("Q:")}  ${c.bold(input)}`);
    printTelemetry(telemetry, mode.label, model.label);
    console.log("");
  }

  console.log(`\n  ${c.dim("Goodbye.")}\n`);
}
