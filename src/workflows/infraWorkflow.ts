import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClarifyAgent } from "../agents/clarifyAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { AwsPlannerAgent } from "../agents/awsPlannerAgent";
import { ExecutorAgent } from "../agents/executorAgent";
import { DiagnoseAgent } from "../agents/diagnoseAgent";
import { AskAgent } from "../agents/askAgent";
import { askForApproval } from "../cli/prompts";
import { AwsExecutorService } from "../services/awsExecutorService";
import { RateLimiterService } from "../services/rateLimiterService";
import { SubscriptionService } from "../services/subscriptionService";
import { TerraformRegistryClient, ProviderSchema } from "../services/terraformRegistryClient";
import { TerraformMcpService } from "../services/terraformMcpService";
import { TracingService } from "../services/tracingService";
import { InfraPlan, PlanStep, TenantContext, DebugOptions } from "../types";
import {
  c,
  sym,
  Spinner,
  printBoxHeader,
  printKV,
  printRule,
  printOutputBlock,
  elapsed,
} from "../utils/terminal";

// ─── Unified diff helpers ─────────────────────────────────────────────────────

type EditOp = { type: "keep" | "delete" | "insert"; line: string };

/**
 * LCS-based line diff. Returns an ordered list of keep/delete/insert operations.
 * Capped at 500k cell matrix to avoid O(m*n) blowup on very large files.
 */
function computeDiff(prev: string[], next: string[]): EditOp[] {
  const m = prev.length, n = next.length;

  if (m * n > 500_000) {
    // Fallback for huge files — show as full replace
    return [
      ...prev.map((line) => ({ type: "delete" as const, line })),
      ...next.map((line) => ({ type: "insert" as const, line })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = prev[i - 1] === next[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops: EditOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && prev[i - 1] === next[j - 1]) {
      ops.unshift({ type: "keep", line: prev[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "insert", line: next[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "delete", line: prev[i - 1] });
      i--;
    }
  }
  return ops;
}

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: EditOp[] }

/** Group diff ops into hunks, each padded with `ctx` context lines. */
function buildHunks(ops: EditOp[], ctx: number): Hunk[] {
  const changed = ops.map((op, i) => (op.type !== "keep" ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return [];

  // Merge overlapping/adjacent context windows into ranges
  const ranges: Array<{ from: number; to: number }> = [];
  let from = Math.max(0, changed[0] - ctx);
  let to   = Math.min(ops.length - 1, changed[0] + ctx);
  for (let ci = 1; ci < changed.length; ci++) {
    const nf = Math.max(0, changed[ci] - ctx);
    const nt = Math.min(ops.length - 1, changed[ci] + ctx);
    if (nf <= to + 1) { to = nt; } else { ranges.push({ from, to }); from = nf; to = nt; }
  }
  ranges.push({ from, to });

  return ranges.map(({ from, to }) => {
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k].type !== "insert") oldStart++;
      if (ops[k].type !== "delete") newStart++;
    }
    const lines = ops.slice(from, to + 1);
    const oldCount = lines.filter((o) => o.type !== "insert").length;
    const newCount = lines.filter((o) => o.type !== "delete").length;
    return { oldStart, oldCount, newStart, newCount, lines };
  });
}

// ─── Risk badge ───────────────────────────────────────────────────────────────

function riskBadge(risk: PlanStep["risk"]): string {
  return risk === "high"
    ? c.bold(c.red("[HIGH]"))
    : risk === "medium"
      ? c.yellow("[MED] ")
      : c.green("[LOW] ");
}

// ─── Workflow class ───────────────────────────────────────────────────────────

export class InfraWorkflow {
  constructor(
    private readonly clarifyAgent: ClarifyAgent,
    private readonly plannerAgent: PlannerAgent,
    private readonly awsPlannerAgent: AwsPlannerAgent,
    private readonly executorAgent: ExecutorAgent,
    private readonly diagnoseAgent: DiagnoseAgent,
    private readonly askAgent: AskAgent,
    private readonly registryClient: TerraformRegistryClient,
    private readonly terraformMcp: TerraformMcpService,
    private readonly rateLimiter: RateLimiterService,
    private readonly subscription: SubscriptionService,
    private readonly tracing: TracingService,
  ) {}

  // ── create (Terraform) ───────────────────────────────────────────────────────

  async createOrUpdate(rawInput: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "create");
    this.tracing.debug(trace, "Workflow start", { rawInput, tenantId: tenant.tenantId });
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    console.log("");

    const { plan } = await this.clarifyAndPlan(rawInput, trace);

    const approved = await askForApproval("Apply this plan to your AWS account?");
    if (!approved) {
      this.tracing.log(trace, "User denied plan approval");
      console.log(`  ${c.dim("Approval denied. No changes made.")}`);
      return;
    }
    this.subscription.assertCanApply(tenant);

    console.log("");
    const sp = new Spinner().start("Running terraform plan & apply");
    const result = await this.executorAgent.execute(tenant.tenantId, plan);
    sp.succeed(`Done  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);

    printOutputBlock("terraform plan", result.planOutput);
    printOutputBlock("terraform apply", result.applyOutput);
    this.tracing.log(trace, "Workflow completed", { latencyMs: Date.now() - startedAt, planId: plan.planId });
  }

  // ── plan (dry run) ───────────────────────────────────────────────────────────

  async planOnly(rawInput: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "plan");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    console.log("");

    const { plan } = await this.clarifyAndPlan(rawInput, trace);

    const sp = new Spinner().start("Running terraform plan (dry run)");
    const output = await this.executorAgent.dryRun(tenant.tenantId, plan);
    sp.succeed(`Terraform plan complete  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    this.tracing.log(trace, "Terraform plan generated", { dir: output.dir, planId: plan.planId });

    printOutputBlock("terraform plan", output.planOutput);
    this.tracing.log(trace, "Workflow completed", { latencyMs: Date.now() - startedAt });
  }

  // ── apply ────────────────────────────────────────────────────────────────────

  async applyExisting(rawInput: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "apply");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    this.subscription.assertCanApply(tenant);
    console.log("");

    const { plan } = await this.clarifyAndPlan(rawInput, trace);

    const approved = await askForApproval("Apply this plan to your AWS account?");
    if (!approved) {
      this.tracing.log(trace, "User denied apply approval");
      console.log(`  ${c.dim("Apply cancelled.")}`);
      return;
    }

    console.log("");
    const sp = new Spinner().start("Applying changes");
    const result = await this.executorAgent.execute(tenant.tenantId, plan);
    sp.succeed(`Applied  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);

    printOutputBlock("terraform apply", result.applyOutput);
    this.tracing.log(trace, "Workflow completed", { latencyMs: Date.now() - startedAt, planId: plan.planId });
  }

  // ── create via direct AWS SDK ────────────────────────────────────────────────

  /**
   * Direct AWS SDK path — skips Terraform entirely.
   * Used when --engine aws is set.
   */
  async createWithAwsSdk(rawInput: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "create-aws");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    console.log("");

    // Step 1 — agentic clarification loop
    const { enrichedInstruction } = await this.clarifyAgent.run(rawInput);
    this.tracing.debug(trace, "Requirements gathered", { enrichedInstruction });

    // Step 2 — generate AWS Cloud Control call plan
    const sp2 = new Spinner().start("Generating AWS API call plan");
    const plan = await this.awsPlannerAgent.generatePlan(enrichedInstruction, tenant.awsRegion);
    sp2.succeed(`Plan ready  ${c.dim("·")}  ${c.bold(String(plan.calls.length))} API calls  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "AWS plan generated", { planId: plan.planId, calls: plan.calls.length });
    console.log("");
    this.printPlanSummary({ ...plan, action: "create", terraform: { files: {} } });

    console.log(`  ${c.bold("Cloud Control Calls")}\n`);
    plan.calls.forEach((call, i) => {
      console.log(`    ${c.dim(String(i + 1) + ".")} ${c.cyan(call.typeName)}  ${c.bold(call.operation.toUpperCase())}  ${c.dim("—")}  ${call.description}`);
    });
    console.log("");

    const approved = await askForApproval("Execute these Cloud Control calls?");
    if (!approved) {
      this.tracing.log(trace, "User denied AWS plan");
      console.log(`  ${c.dim("Cancelled. No changes made.")}`);
      return;
    }
    this.subscription.assertCanApply(tenant);

    // Step 3 — execute calls sequentially
    console.log("");
    const executor = new AwsExecutorService(tenant.awsRegion, tenant.awsCredentials);
    let failCount = 0;
    for (const call of plan.calls) {
      const sp = new Spinner().start(`${c.cyan(call.typeName)}  ${c.bold(call.operation.toUpperCase())}`);
      const [result] = await executor.execute([call]);
      if (result.success) {
        sp.succeed(
          `${c.cyan(call.typeName)}  ${c.bold(call.operation.toUpperCase())}` +
          (result.identifier ? `  ${c.dim("id:")} ${c.dim(result.identifier)}` : "") +
          `  ${c.dim("—")}  ${c.dim(call.description)}`,
        );
      } else {
        sp.fail(`${c.cyan(call.typeName)}  ${c.red("FAILED")}  ${c.dim(result.error ?? "")}`);
        failCount++;
        break;
      }
    }

    if (failCount === 0) {
      console.log(`\n  ${c.green("✓")} All API calls succeeded  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    }
    this.tracing.log(trace, "AWS create workflow completed", { latencyMs: Date.now() - startedAt, planId: plan.planId, failCount });
  }

  // ── update (SRE patch flow) ──────────────────────────────────────────────────

  /**
   * SRE update flow: agentic clarification → read existing TF files → patch →
   * show diff → terraform plan → apply.
   *
   * @param instruction  Plain-language change description.
   * @param tfDir        Absolute path to the existing Terraform directory.
   * @param tenant       Tenant context.
   */
  async updateExisting(instruction: string, tfDir: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "update");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    console.log("");

    // Step 1 — read existing files first so ClarifyAgent can reference them
    const sp1 = new Spinner().start(`Reading Terraform files from ${c.cyan(tfDir)}`);
    const existingFiles = await this.terraformMcp.readExistingFiles(tfDir);
    sp1.succeed(`Read ${c.bold(String(Object.keys(existingFiles).length))} files  ${c.dim(Object.keys(existingFiles).join(", "))}`);
    this.tracing.debug(trace, "Existing files read", { tfDir, files: Object.keys(existingFiles) });

    // Step 2 — agentic clarification loop (existing files give the LLM context)
    const { enrichedInstruction, resourceTypes: newTypes } = await this.clarifyAgent.run(instruction, existingFiles);
    this.tracing.debug(trace, "Requirements gathered", { enrichedInstruction });

    // Step 3 — fetch schemas for both new and existing resource types
    const existingTypes = this.detectResourceTypes(existingFiles);
    const allTypes = [...new Set([...newTypes, ...existingTypes])];
    const sp3 = new Spinner().start("Fetching provider schemas");
    const schemas = await this.fetchSchemas(trace, allTypes);
    sp3.succeed(
      schemas.length > 0
        ? `Schemas  ${c.dim(schemas.map((s) => s.resourceType).join(", "))}`
        : `Schemas  ${c.dim("registry unavailable — proceeding without")}`,
    );

    // Step 4 — LLM patches the files
    const sp4 = new Spinner().start("Generating file patches");
    const plan = await this.plannerAgent.patchExisting(existingFiles, enrichedInstruction, schemas);
    sp4.succeed(`Patches ready  ${c.dim("·")}  ${c.bold(String(plan.steps.length))} steps  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "Patch plan generated", { planId: plan.planId });
    console.log("");
    this.printPlanSummary(plan);

    // Step 5 — show diff per file
    this.printFileDiff(existingFiles, plan.terraform.files);

    const approved = await askForApproval("Write these changes and run terraform plan?");
    if (!approved) {
      this.tracing.log(trace, "User denied patch approval");
      console.log(`  ${c.dim("Cancelled. No files written.")}`);
      return;
    }
    this.subscription.assertCanApply(tenant);

    // Step 6 — write patched files back to disk
    const sp6 = new Spinner().start("Writing updated files");
    await this.terraformMcp.writeFiles(tfDir, plan.terraform.files);
    sp6.succeed(`Files written to ${c.cyan(tfDir)}`);

    // Step 7 — terraform plan
    console.log("");
    const sp7 = new Spinner().start("Running terraform plan");
    const tfPlanOut = await this.terraformMcp.runPlan(tfDir);
    sp7.succeed(`Terraform plan complete  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    printOutputBlock("terraform plan", tfPlanOut);

    const applyApproved = await askForApproval("Apply these changes to your AWS account?");
    if (!applyApproved) {
      this.tracing.log(trace, "User denied apply after plan");
      console.log(`  ${c.dim("Apply cancelled. Files remain updated on disk.")}`);
      return;
    }

    // Step 8 — terraform apply
    const sp8 = new Spinner().start("Applying changes");
    const tfApplyOut = await this.terraformMcp.runApply(tfDir);
    sp8.succeed(`Applied  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    printOutputBlock("terraform apply", tfApplyOut);
    this.tracing.log(trace, "Update workflow completed", { latencyMs: Date.now() - startedAt, planId: plan.planId });
  }

  // ── debug ────────────────────────────────────────────────────────────────────

  async debug(serviceName: string, tenant: TenantContext, debugOptions: DebugOptions): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "debug");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    this.tracing.log(trace, "Debug workflow start", { serviceName, tenantId: tenant.tenantId });

    const options: DebugOptions = { ...debugOptions, awsRegion: tenant.awsRegion };
    const report = await this.diagnoseAgent.run(serviceName, tenant.awsRegion, options, tenant.awsCredentials);
    if (report) console.log(report);

    this.tracing.log(trace, "Debug workflow completed", { latencyMs: Date.now() - startedAt, serviceName });
  }

  // ── diagnose ─────────────────────────────────────────────────────────────────

  async diagnose(question: string, tenant: TenantContext, k8sContext?: string): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "diagnose");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    this.tracing.log(trace, "Diagnose workflow start", { question, tenantId: tenant.tenantId });

    printBoxHeader("Diagnose");
    printKV("Question", c.bold(question), { keyWidth: 10 });
    console.log("");

    const report = await this.diagnoseAgent.run(question, tenant.awsRegion, { k8sContext }, tenant.awsCredentials);
    if (report) console.log(report);

    this.tracing.log(trace, "Diagnose workflow completed", { latencyMs: Date.now() - startedAt });
  }

  // ── ask ──────────────────────────────────────────────────────────────────────

  async ask(question: string, tenant: TenantContext, k8sContext?: string): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "ask");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    this.tracing.log(trace, "Ask workflow start", { question, tenantId: tenant.tenantId });

    const answer = await this.askAgent.run(question, tenant.awsRegion, k8sContext, tenant.awsCredentials);
    if (answer) console.log(answer);

    // ── Persist Q&A to history file ──────────────────────────────────────────
    if (answer) {
      try {
        const dir = join(homedir(), ".infra-copilot");
        mkdirSync(dir, { recursive: true });
        const entry = JSON.stringify({ ts: new Date().toISOString(), question, answer }) + "\n";
        appendFileSync(join(dir, "history.jsonl"), entry, "utf8");
      } catch { /* never block on history write errors */ }
    }

    this.tracing.log(trace, "Ask workflow completed", { latencyMs: Date.now() - startedAt, question });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /**
   * Shared clarify → schemas → plan pipeline for Terraform create/plan/apply workflows.
   * ClarifyAgent drives the conversation; planner generates HCL from the enriched description.
   */
  private async clarifyAndPlan(
    rawInput: string,
    trace: ReturnType<TracingService["createTrace"]>,
  ): Promise<{ plan: InfraPlan }> {
    const { enrichedInstruction, resourceTypes } = await this.clarifyAgent.run(rawInput);
    this.tracing.debug(trace, "Requirements gathered", { enrichedInstruction, resourceTypes });

    const sp2 = new Spinner().start("Fetching Terraform provider schemas");
    const schemas = await this.fetchSchemas(trace, resourceTypes);
    sp2.succeed(
      schemas.length > 0
        ? `Schemas  ${c.dim(schemas.map((s) => s.resourceType).join(", "))}`
        : `Schemas  ${c.dim("registry unavailable — proceeding without")}`,
    );

    const sp3 = new Spinner().start("Generating infrastructure plan");
    const plan = await this.plannerAgent.generatePlanFromDescription(enrichedInstruction, schemas);
    sp3.succeed(`Plan ready  ${c.dim("·")}  ${c.bold(String(plan.steps.length))} steps  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "Plan generated", { planId: plan.planId, steps: plan.steps.length });
    console.log("");
    this.printPlanSummary(plan);

    return { plan };
  }

  /** Extract `aws_*` resource type strings from raw HCL file contents. */
  private detectResourceTypes(files: Record<string, string>): string[] {
    const combined = Object.values(files).join("\n");
    const matches = [...combined.matchAll(/resource\s+"(aws_[^"]+)"/g)].map((m) => m[1]);
    return [...new Set(matches)];
  }

  /** Print a unified diff (git-style) for every file that changed. */
  private printFileDiff(before: Record<string, string>, after: Record<string, string>): void {
    const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
    let anyDiff = false;

    for (const name of allFiles) {
      const prev = before[name] ?? "";
      const next = after[name] ?? "";
      if (prev === next) continue;
      anyDiff = true;

      const prevLines = prev === "" ? [] : prev.split("\n");
      const nextLines = next === "" ? [] : next.split("\n");

      if (!before[name]) {
        // Brand-new file — show everything as added
        console.log(`\n  ${c.bold(c.green("+ " + name))}  ${c.dim(`(new file · ${nextLines.length} lines)`)}`);
        for (const line of nextLines) console.log(`    ${c.green("+" + line)}`);
        continue;
      }

      if (!after[name]) {
        console.log(`\n  ${c.bold(c.red("- " + name))}  ${c.dim("(deleted)")}`);
        continue;
      }

      // Modified file — unified diff with 3 lines of context
      console.log(`\n  ${c.bold(c.cyan(name))}`);
      const hunks = buildHunks(computeDiff(prevLines, nextLines), 3);
      for (const hunk of hunks) {
        console.log(
          `  ${c.dim(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)}`,
        );
        for (const op of hunk.lines) {
          if (op.type === "keep")   console.log(`    ${c.dim(" " + op.line)}`);
          if (op.type === "delete") console.log(`    ${c.red("-" + op.line)}`);
          if (op.type === "insert") console.log(`    ${c.green("+" + op.line)}`);
        }
      }
    }

    if (!anyDiff) console.log(`  ${c.dim("No file changes detected.")}`);
    console.log("");
  }

  private async fetchSchemas(
    trace: ReturnType<TracingService["createTrace"]>,
    resourceTypes: string[],
  ): Promise<ProviderSchema[]> {
    if (resourceTypes.length === 0) return [];

    const connected = await this.registryClient.connect();
    if (!connected) {
      this.tracing.warn(trace, "Terraform registry MCP server unavailable", {
        hint: "Set TERRAFORM_MCP_URL=http://localhost:8080/mcp (Docker) or install the binary (stdio).",
      });
      return [];
    }

    try {
      const schemas = await this.registryClient.fetchSchemas("aws", resourceTypes);
      this.tracing.log(trace, "Provider schemas fetched", {
        transport: this.registryClient.transport,
        requested: resourceTypes.length,
        resolved: schemas.length,
      });
      return schemas;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.tracing.warn(trace, "Schema fetch failed — proceeding without", { error: message });
      return [];
    } finally {
      await this.registryClient.disconnect().catch(() => {});
    }
  }

  private printPlanSummary(plan: InfraPlan): void {
    const highRisk = plan.steps.filter((s) => s.risk === "high");
    const medRisk  = plan.steps.filter((s) => s.risk === "medium");
    const lowRisk  = plan.steps.filter((s) => s.risk === "low");

    printBoxHeader("Plan Summary");
    console.log("");
    printKV("Plan ID",  c.dim(plan.planId),                                  { keyWidth: 10 });
    printKV("Action",   c.bold(c.cyan(plan.action.toUpperCase())),            { keyWidth: 10 });
    printKV("Steps",    `${c.bold(String(plan.steps.length))} total`  +
      (highRisk.length > 0 ? `  ${c.bold(c.red(`${highRisk.length} high`))}` : "") +
      (medRisk.length  > 0 ? `  ${c.yellow(`${medRisk.length} medium`)}` : "") +
      (lowRisk.length  > 0 ? `  ${c.dim(`${lowRisk.length} low`)}` : ""),    { keyWidth: 10 });
    console.log(`\n    ${c.dim(plan.summary)}`);

    if (highRisk.length > 0) {
      console.log(`\n  ${c.bold(c.red(sym.warn + "  High risk steps"))}  ${c.dim(`(${highRisk.length})`)}`);
      for (const s of highRisk)
        console.log(`    ${riskBadge(s.risk)} ${c.bold(s.target)}  ${c.dim("—")}  ${s.description}`);
    }
    if (medRisk.length > 0) {
      console.log(`\n  ${c.yellow("Medium risk steps")}  ${c.dim(`(${medRisk.length})`)}`);
      for (const s of medRisk)
        console.log(`    ${riskBadge(s.risk)} ${s.target}  ${c.dim("—")}  ${c.dim(s.description)}`);
    }

    console.log("");
    printRule();
    console.log("");
  }
}
