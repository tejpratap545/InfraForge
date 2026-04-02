import { IntentAgent } from "../agents/intentAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { AwsPlannerAgent } from "../agents/awsPlannerAgent";
import { ExecutorAgent } from "../agents/executorAgent";
import { DebuggerAgent } from "../agents/debuggerAgent";
import { DiagnoseAgent } from "../agents/diagnoseAgent";
import { AskAgent } from "../agents/askAgent";
import { collectMissingIntentFields, askForApproval } from "../cli/prompts";
import { AwsInventoryService } from "../services/awsInventoryService";
import { AwsMetricsService } from "../services/awsMetricsService";
import { AwsExecutorService } from "../services/awsExecutorService";
import { K8sInventoryService } from "../services/k8sInventoryService";
import { RateLimiterService } from "../services/rateLimiterService";
import { SubscriptionService } from "../services/subscriptionService";
import { TerraformRegistryClient, ProviderSchema } from "../services/terraformRegistryClient";
import { TerraformMcpService } from "../services/terraformMcpService";
import { TracingService } from "../services/tracingService";
import { InfraPlan, Intent, PlanStep, TenantContext, DebugOptions } from "../types";
import {
  c,
  sym,
  Spinner,
  printBoxHeader,
  printKV,
  printRule,
  renderReport,
  printOutputBlock,
  elapsed,
} from "../utils/terminal";

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
    private readonly intentAgent: IntentAgent,
    private readonly plannerAgent: PlannerAgent,
    private readonly awsPlannerAgent: AwsPlannerAgent,
    private readonly executorAgent: ExecutorAgent,
    private readonly debuggerAgent: DebuggerAgent,
    private readonly diagnoseAgent: DiagnoseAgent,
    private readonly askAgent: AskAgent,
    private readonly awsInventory: AwsInventoryService,
    private readonly awsMetrics: AwsMetricsService,
    private readonly k8sInventory: K8sInventoryService,
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

    const { plan } = await this.parseIntentAndPlan(rawInput, trace);

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

    const { plan } = await this.parseIntentAndPlan(rawInput, trace);

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

    const { plan } = await this.parseIntentAndPlan(rawInput, trace);

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

    // Step 1 — parse intent
    const sp1 = new Spinner().start("Parsing intent");
    let intent = await this.intentAgent.parse(rawInput);
    const questions = await this.intentAgent.suggestClarificationQuestions(intent);
    sp1.succeed(
      `Intent parsed  ${c.dim("→")}  ${intent.resourceTypes.join(", ")}` +
        (intent.region ? `  ${c.dim("·")}  ${c.cyan(intent.region)}` : ""),
    );
    if (questions.length > 0) {
      console.log("");
      intent = await collectMissingIntentFields(intent, questions);
    }

    // Step 2 — generate AWS SDK call plan
    const sp2 = new Spinner().start("Generating AWS API call plan");
    const plan = await this.awsPlannerAgent.generatePlan(intent);
    sp2.succeed(`Plan ready  ${c.dim("·")}  ${c.bold(String(plan.calls.length))} API calls  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "AWS plan generated", { planId: plan.planId, calls: plan.calls.length });
    console.log("");
    this.printPlanSummary({ ...plan, action: "create", terraform: { files: {} } });

    // Print call list
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
    const executor = new AwsExecutorService(intent.region ?? tenant.awsRegion);
    let failCount = 0;
    for (const call of plan.calls) {
      const sp = new Spinner().start(`${c.cyan(call.typeName)}  ${c.bold(call.operation.toUpperCase())}`);
      const [result] = await executor.execute([call]);
      if (result.success) {
        sp.succeed(`${c.cyan(call.typeName)}  ${c.bold(call.operation.toUpperCase())}` +
          (result.identifier ? `  ${c.dim("id:")} ${c.dim(result.identifier)}` : "") +
          `  ${c.dim("—")}  ${c.dim(call.description)}`);
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
   * SRE update flow: read an existing Terraform directory, patch it with LLM,
   * show a file diff for approval, then run terraform plan → apply.
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

    // Step 1 — read existing files
    const sp1 = new Spinner().start(`Reading Terraform files from ${c.cyan(tfDir)}`);
    const existingFiles = await this.terraformMcp.readExistingFiles(tfDir);
    sp1.succeed(`Read ${c.bold(String(Object.keys(existingFiles).length))} files  ${c.dim(Object.keys(existingFiles).join(", "))}`);
    this.tracing.debug(trace, "Existing files read", { tfDir, files: Object.keys(existingFiles) });

    // Step 2 — fetch schemas based on resource types already in the files
    const detectedTypes = this.detectResourceTypes(existingFiles);
    const sp2 = new Spinner().start("Fetching provider schemas");
    const schemas = await this.fetchSchemas(trace, { resourceTypes: detectedTypes, action: "patch", rawInput: instruction });
    sp2.succeed(
      schemas.length > 0
        ? `Schemas  ${c.dim(schemas.map((s) => s.resourceType).join(", "))}`
        : `Schemas  ${c.dim("registry unavailable — proceeding without")}`,
    );

    // Step 3 — LLM patches the files
    const sp3 = new Spinner().start("Generating file patches");
    const plan = await this.plannerAgent.patchExisting(existingFiles, instruction, schemas);
    sp3.succeed(`Patches ready  ${c.dim("·")}  ${c.bold(String(plan.steps.length))} steps  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "Patch plan generated", { planId: plan.planId });
    console.log("");
    this.printPlanSummary(plan);

    // Step 4 — show diff per file
    this.printFileDiff(existingFiles, plan.terraform.files);

    const approved = await askForApproval("Write these changes and run terraform plan?");
    if (!approved) {
      this.tracing.log(trace, "User denied patch approval");
      console.log(`  ${c.dim("Cancelled. No files written.")}`);
      return;
    }
    this.subscription.assertCanApply(tenant);

    // Step 5 — write patched files back to the same directory
    const sp5 = new Spinner().start("Writing updated files");
    await this.terraformMcp.writeFiles(tfDir, plan.terraform.files);
    sp5.succeed(`Files written to ${c.cyan(tfDir)}`);

    // Step 6 — terraform plan (in-place — files already on disk)
    console.log("");
    const sp6 = new Spinner().start("Running terraform plan");
    const tfPlanOut = await this.terraformMcp.runPlan(tfDir);
    sp6.succeed(`Terraform plan complete  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    printOutputBlock("terraform plan", tfPlanOut);

    const applyApproved = await askForApproval("Apply these changes to your AWS account?");
    if (!applyApproved) {
      this.tracing.log(trace, "User denied apply after plan");
      console.log(`  ${c.dim("Apply cancelled. Files remain updated on disk.")}`);
      return;
    }

    // Step 7 — terraform apply
    const sp7 = new Spinner().start("Applying changes");
    const tfApplyOut = await this.terraformMcp.runApply(tfDir);
    sp7.succeed(`Applied  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);
    printOutputBlock("terraform apply", tfApplyOut);
    this.tracing.log(trace, "Update workflow completed", { latencyMs: Date.now() - startedAt, planId: plan.planId });
  }

  // ── debug ────────────────────────────────────────────────────────────────────

  async debug(serviceName: string, tenant: TenantContext, debugOptions: DebugOptions): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "debug");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    const options: DebugOptions = { ...debugOptions, awsRegion: tenant.awsRegion };
    console.log("");

    const sp1 = new Spinner().start(`Collecting signals for ${c.bold(serviceName)}`);
    this.tracing.log(trace, "Fetching debug signals", { serviceName });

    const sp2 = new Spinner().start("Analyzing with LLM");
    const report = await this.debuggerAgent.analyze(serviceName, options)
      .finally(() => sp2.succeed(`Analysis complete  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`));

    sp1.succeed(`Signals collected  ${c.dim("·")}  ${c.dim(options.since ?? "1h")} look-back`);

    console.log("");
    printBoxHeader(`Debug Report  ·  ${serviceName}`);
    printKV("Service",   c.bold(serviceName),         { keyWidth: 10 });
    printKV("Look-back", c.cyan(options.since ?? "1h"), { keyWidth: 10 });
    console.log("");
    console.log(renderReport(report));
    this.tracing.log(trace, "Workflow completed", { latencyMs: Date.now() - startedAt, serviceName });
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

    const report = await this.diagnoseAgent.run(question, tenant.awsRegion, k8sContext);
    if (report) console.log(report);

    this.tracing.log(trace, "Diagnose workflow completed", { latencyMs: Date.now() - startedAt });
  }

  // ── ask ──────────────────────────────────────────────────────────────────────

  async ask(question: string, tenant: TenantContext): Promise<void> {
    const startedAt = Date.now();
    const trace = this.tracing.createTrace(tenant.tenantId, "ask");
    this.rateLimiter.assertWithinLimit(tenant, this.subscription.getLimits(tenant).commandsPerMinute);
    console.log("");

    const sp1 = new Spinner().start("Understanding your AWS question");
    const plan = await this.askAgent.plan(question);
    if (plan.questionType === "unknown") {
      sp1.fail("Could not map question to AWS inventory");
      throw new Error(
        plan.unsupportedReason ??
          "Ask mode could not map that question to the current live AWS inventory capabilities.",
      );
    }
    const resolvedRegion = plan.region?.trim() || tenant.awsRegion;
    sp1.succeed(
      `Understood  ${c.dim(sym.arrow)}  targets: ${c.cyan(plan.targets.join(", "))}  ${c.dim("·")}  ${c.dim(plan.questionType)}  ${c.dim("·")}  ${c.cyan(resolvedRegion)}`,
    );
    this.tracing.log(trace, "Ask plan generated", { question, targets: plan.targets, region: resolvedRegion });

    // Collect all three data tracks in parallel
    const hasInventory = plan.targets.length > 0;
    const hasMetrics   = !!plan.metricsQuery;
    const hasK8s       = !!plan.k8sQuery;

    const sp2Label = hasK8s
      ? `Querying Kubernetes  ${c.dim("·")}  ${this.askAgent.describeK8sQuery(plan.k8sQuery!)}`
      : hasMetrics && !hasInventory
        ? `Querying CloudWatch  ${c.dim("·")}  ${this.askAgent.describeMetricsQuery(plan.metricsQuery!)}`
        : "Collecting live data";
    const sp2 = new Spinner().start(sp2Label);

    const emptySnapshot = { accountId: undefined, accountArn: undefined, region: resolvedRegion, generatedAt: new Date().toISOString(), services: {} };

    const [snapshot, metricsText, k8sText] = await Promise.all([
      hasInventory
        ? this.awsInventory.collect(plan.targets, resolvedRegion)
        : Promise.resolve(emptySnapshot),
      hasMetrics
        ? this.awsMetrics.query(plan.metricsQuery!, resolvedRegion)
        : Promise.resolve(undefined),
      hasK8s
        ? this.k8sInventory.query(plan.k8sQuery!, resolvedRegion)
        : Promise.resolve(undefined),
    ]);

    const succeeded = Object.values(snapshot.services).filter((s) => s && !s.error).length;
    if (hasInventory && succeeded === 0 && !hasMetrics && !hasK8s) {
      sp2.fail("Could not collect AWS inventory");
      throw new Error("Could not collect AWS inventory. Check AWS credentials, region, and IAM permissions.");
    }
    const total = Object.values(snapshot.services).reduce((n, s) => n + (s?.count ?? 0), 0);
    const parts = [
      hasInventory ? `${c.bold(String(succeeded))} services  ${c.dim("·")}  ${c.bold(String(total))} resources` : "",
      hasMetrics   ? c.dim("CloudWatch") : "",
      hasK8s       ? c.dim("Kubernetes") : "",
    ].filter(Boolean).join(`  ${c.dim("·")}  `);
    sp2.succeed(`Data ready  ${c.dim("·")}  ${parts}`);
    this.tracing.log(trace, "Data collected", { targets: plan.targets, succeeded, hasMetrics, hasK8s });

    const sp3 = new Spinner().start("Answering with live data");
    const answer = await this.askAgent.answer(question, snapshot, metricsText ?? undefined, k8sText ?? undefined);
    sp3.succeed(`Done  ${c.dim("·")}  ${c.dim(elapsed(startedAt))}`);

    console.log("");
    printBoxHeader("AWS Inventory Answer");
    printKV("Question", c.bold(question), { keyWidth: 10 });
    printKV("Region",   c.cyan(resolvedRegion), { keyWidth: 10 });
    console.log("");
    console.log(renderReport(answer));
    this.tracing.log(trace, "Workflow completed", { latencyMs: Date.now() - startedAt, question });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** Shared parse → clarify → schemas → plan pipeline for Terraform workflows. */
  private async parseIntentAndPlan(
    rawInput: string,
    trace: ReturnType<TracingService["createTrace"]>,
  ): Promise<{ intent: Intent; plan: InfraPlan }> {
    const sp1 = new Spinner().start("Parsing intent");
    let intent = await this.intentAgent.parse(rawInput);
    const questions = await this.intentAgent.suggestClarificationQuestions(intent);
    sp1.succeed(
      `Intent parsed  ${c.dim(sym.arrow)}  ${intent.resourceTypes.join(", ")}` +
        (intent.region ? `  ${c.dim("·")}  ${c.cyan(intent.region)}` : ""),
    );
    if (questions.length > 0) {
      console.log("");
      intent = await collectMissingIntentFields(intent, questions);
    }
    this.tracing.debug(trace, "Intent parsed", { intent });

    const sp2 = new Spinner().start("Fetching Terraform provider schemas");
    const schemas = await this.fetchSchemas(trace, intent);
    sp2.succeed(
      schemas.length > 0
        ? `Schemas  ${c.dim(schemas.map((s) => s.resourceType).join(", "))}`
        : `Schemas  ${c.dim("registry unavailable — proceeding without")}`,
    );

    const sp3 = new Spinner().start("Generating infrastructure plan");
    const plan = await this.plannerAgent.generatePlan(intent, schemas);
    sp3.succeed(`Plan ready  ${c.dim("·")}  ${c.bold(String(plan.steps.length))} steps  ${c.dim(plan.planId)}`);
    this.tracing.debug(trace, "Plan generated", { planId: plan.planId, steps: plan.steps.length });
    console.log("");
    this.printPlanSummary(plan);

    return { intent, plan };
  }

  /** Extract `aws_*` resource type strings from raw HCL file contents. */
  private detectResourceTypes(files: Record<string, string>): string[] {
    const combined = Object.values(files).join("\n");
    const matches = [...combined.matchAll(/resource\s+"(aws_[^"]+)"/g)].map((m) => m[1]);
    return [...new Set(matches)];
  }

  /** Print a simple before/after diff for each file that changed. */
  private printFileDiff(before: Record<string, string>, after: Record<string, string>): void {
    const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
    let anyDiff = false;
    for (const name of allFiles) {
      const prev = before[name] ?? "";
      const next = after[name] ?? "";
      if (prev === next) continue;
      anyDiff = true;
      console.log(`\n  ${c.bold(c.cyan(name))}`);
      const prevLines = prev.split("\n");
      const nextLines = next.split("\n");
      // Print removed lines (in before but not after)
      for (const line of prevLines) {
        if (!nextLines.includes(line)) console.log(`    ${c.red("- " + line)}`);
      }
      // Print added lines (in after but not before)
      for (const line of nextLines) {
        if (!prevLines.includes(line)) console.log(`    ${c.green("+ " + line)}`);
      }
    }
    if (!anyDiff) console.log(`  ${c.dim("No file changes detected.")}`);
    console.log("");
  }

  private async fetchSchemas(
    trace: ReturnType<TracingService["createTrace"]>,
    intent: Intent,
  ): Promise<ProviderSchema[]> {
    if (intent.resourceTypes.length === 0) return [];

    const connected = await this.registryClient.connect();
    if (!connected) {
      this.tracing.warn(trace, "Terraform registry MCP server unavailable", {
        hint: "Set TERRAFORM_MCP_URL=http://localhost:8080/mcp (Docker) or install the binary (stdio).",
      });
      return [];
    }

    try {
      const schemas = await this.registryClient.fetchSchemas("aws", intent.resourceTypes);
      this.tracing.log(trace, "Provider schemas fetched", {
        transport: this.registryClient.transport,
        requested: intent.resourceTypes.length,
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
