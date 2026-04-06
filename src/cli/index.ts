#!/usr/bin/env node
import { Command } from "commander";
import { cwd } from "node:process";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClarifyAgent } from "../agents/clarifyAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { AwsPlannerAgent } from "../agents/awsPlannerAgent";
import { ExecutorAgent } from "../agents/executorAgent";
import { DiagnoseAgent } from "../agents/diagnoseAgent";
import { AskAgent } from "../agents/askAgent";
import { BedrockService } from "../services/bedrockService";
import { TerraformMcpService } from "../services/terraformMcpService";
import { AwsMcpService } from "../services/awsMcpService";
import { TerraformRegistryClient } from "../services/terraformRegistryClient";
import { RateLimiterService } from "../services/rateLimiterService";
import { SubscriptionService } from "../services/subscriptionService";
import { TracingService } from "../services/tracingService";
import { TenantService } from "../services/tenantService";
import { createLogger, getConfiguredLogLevel } from "../utils/logging";
import { InfraWorkflow } from "../workflows/infraWorkflow";
import { runInteractiveSession } from "./interactive";
import { TelemetryCollector } from "../services/telemetryCollector";

const log = createLogger({ component: "cli" });

// ─── AWS profile region resolution ───────────────────────────────────────────

function regionFromAwsProfile(): string | undefined {
  try {
    const profile = process.env.AWS_PROFILE ?? process.env.AWS_DEFAULT_PROFILE ?? "default";
    const configPath = process.env.AWS_CONFIG_FILE ?? join(os.homedir(), ".aws", "config");
    const content = readFileSync(configPath, "utf-8");
    const header = profile === "default" ? "\\[default\\]" : `\\[profile ${profile}\\]`;
    const sectionMatch = new RegExp(`${header}([\\s\\S]*?)(?=\\[|$)`).exec(content);
    if (!sectionMatch) return undefined;
    const regionMatch = /^\s*region\s*=\s*(.+)$/m.exec(sectionMatch[1]);
    return regionMatch?.[1].trim();
  } catch {
    return undefined;
  }
}

// ─── Workflow factory ─────────────────────────────────────────────────────────

function makeWorkflow(
  region: string,
  modelId?: string,
  telemetry?: TelemetryCollector,
  bedrockCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): InfraWorkflow {
  const bedrock       = new BedrockService(region, modelId, telemetry, bedrockCredentials);
  const clarifyAgent  = new ClarifyAgent(bedrock);
  const plannerAgent  = new PlannerAgent(bedrock);
  const awsPlannerAgent = new AwsPlannerAgent(bedrock);
  const terraformMcp  = new TerraformMcpService(cwd());
  const executorAgent = new ExecutorAgent(terraformMcp);
  const awsMcp        = new AwsMcpService();
  const askAgent      = new AskAgent(bedrock, awsMcp);
  const diagnoseAgent = new DiagnoseAgent(bedrock, awsMcp);
  const registryClient = new TerraformRegistryClient();
  return new InfraWorkflow(
    clarifyAgent, plannerAgent, awsPlannerAgent, executorAgent,
    diagnoseAgent, askAgent, registryClient, terraformMcp,
    new RateLimiterService(), new SubscriptionService(), new TracingService(),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const program = new Command();
  program.name("infraforge").description("InfraForge — AI Infrastructure & SRE Platform").version("1.0.0");

  // ── Global options ──────────────────────────────────────────────────────────
  program
    .option("--tenant-id <id>",    "tenant identifier",            process.env.TENANT_ID)
    .option("--user-id <id>",      "user identifier",              process.env.USER_ID)
    .option("--subscription <tier>", "free|pro|enterprise",        process.env.SUBSCRIPTION_TIER ?? "pro")
    .option("--region <region>",   "AWS region",
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? regionFromAwsProfile() ?? "ap-south-1")
    // Bedrock LLM credentials
    .option("--bedrock-access-key-id <key>",     "Bedrock account access key",    process.env.BEDROCK_ACCESS_KEY_ID)
    .option("--bedrock-secret-access-key <key>", "Bedrock account secret key",    process.env.BEDROCK_SECRET_ACCESS_KEY)
    .option("--bedrock-session-token <token>",   "Bedrock account session token", process.env.BEDROCK_SESSION_TOKEN)
    // Tenant (infrastructure) credentials
    .option("--aws-access-key-id <key>",     "Tenant AWS access key",    process.env.TENANT_AWS_ACCESS_KEY_ID)
    .option("--aws-secret-access-key <key>", "Tenant AWS secret key",    process.env.TENANT_AWS_SECRET_ACCESS_KEY)
    .option("--aws-session-token <token>",   "Tenant AWS session token", process.env.TENANT_AWS_SESSION_TOKEN)
    // LLM tuning
    .option("--model <modelId>",     "Bedrock model ID",                                       process.env.BEDROCK_MODEL_ID)
    .option("--reasoning <depth>",   "quick (8 steps) | standard (25) | deep (40)",            "standard")
    .option("--log-level <level>",   "debug | info | warn | error",                            getConfiguredLogLevel());

  type GlobalOpts = {
    tenantId?: string;
    userId?: string;
    subscription: "free" | "pro" | "enterprise";
    region: string;
    bedrockAccessKeyId?: string;
    bedrockSecretAccessKey?: string;
    bedrockSessionToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
    model?: string;
    reasoning: "quick" | "standard" | "deep";
    logLevel: "debug" | "info" | "warn" | "error";
  };

  const tenantService = new TenantService();

  const buildTenant = () => {
    const opts = program.opts<GlobalOpts>();
    process.env.LOG_LEVEL = opts.logLevel;
    const awsCredentials = opts.awsAccessKeyId && opts.awsSecretAccessKey
      ? { accessKeyId: opts.awsAccessKeyId, secretAccessKey: opts.awsSecretAccessKey, sessionToken: opts.awsSessionToken }
      : undefined;
    return tenantService.buildContext({
      tenantId:         opts.tenantId ?? process.env.TENANT_ID ?? "local",
      userId:           opts.userId   ?? process.env.USER_ID   ?? os.userInfo().username,
      subscriptionTier: opts.subscription,
      awsRegion:        opts.region,
      awsCredentials,
    });
  };

  const bedrockCreds = () => {
    const opts = program.opts<GlobalOpts>();
    return opts.bedrockAccessKeyId && opts.bedrockSecretAccessKey
      ? { accessKeyId: opts.bedrockAccessKeyId, secretAccessKey: opts.bedrockSecretAccessKey, sessionToken: opts.bedrockSessionToken }
      : undefined;
  };

  const modelId   = () => program.opts<GlobalOpts>().model;
  const reasoning = () => program.opts<GlobalOpts>().reasoning;

  // ── ask ─────────────────────────────────────────────────────────────────────
  // Simple Q&A: inventory questions, resource counts, status checks.

  program
    .command("ask")
    .description("Ask a plain-English question about your AWS/K8s environment.")
    .requiredOption("-q, --question <question>", "e.g. \"how many EKS clusters?\"")
    .option("--k8s-context <context>", "kubectl context (default: current context)")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, modelId(), undefined, bedrockCreds());
      await workflow.ask(cmd.question, tenant, cmd.k8sContext, reasoning());
    });

  // ── diagnose ─────────────────────────────────────────────────────────────────
  // Deep incident investigation: root cause analysis across AWS, K8s, logs.

  program
    .command("diagnose")
    .description("Deep investigation of incidents, failures, and performance issues.")
    .requiredOption("-q, --question <question>", "e.g. \"why is mimir crashing?\"")
    .option("--k8s-context <context>",    "kubectl context (default: current context)")
    .option("-n, --namespace <ns>",       "Kubernetes namespace to focus on")
    .option("--since <duration>",         "look-back window: 30m | 1h | 6h | 24h (default: 1h)")
    .option("--tail <lines>",             "max log lines per source",                "50")
    .option("--log-groups <groups>",      "comma-separated CloudWatch log group names")
    .option("--loki-url <url>",           "Loki base URL, e.g. http://loki:3100")
    .option("--opensearch-url <url>",     "OpenSearch base URL")
    .option("--opensearch-index <pattern>","OpenSearch index pattern (default: *)")
    .option("--opensearch-user <user>",   "OpenSearch basic-auth username")
    .option("--opensearch-pass <pass>",   "OpenSearch basic-auth password")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, modelId(), undefined, bedrockCreds());
      await workflow.diagnose(cmd.question, tenant, cmd.k8sContext, reasoning());
    });

  // ── plan ─────────────────────────────────────────────────────────────────────
  // Infrastructure management: create, dry-run, apply.

  const planCmd = program
    .command("plan")
    .description("Infrastructure planning and execution. Use a subcommand: create | dry-run | apply");

  // plan create
  planCmd
    .command("create")
    .description("Generate an infrastructure plan and apply after confirmation.")
    .requiredOption("-i, --input <instruction>", "plain-language intent, e.g. \"create RDS PostgreSQL\"")
    .option("--mode <engine>", "aws | terraform", "terraform")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, modelId(), undefined, bedrockCreds());
      if (cmd.mode === "aws") {
        await workflow.createWithAwsSdk(cmd.input, tenant);
      } else {
        await workflow.createOrUpdate(cmd.input, tenant);
      }
    });

  // plan dry-run
  planCmd
    .command("dry-run")
    .description("Generate a plan and show what would change — no execution.")
    .requiredOption("-i, --input <instruction>", "plain-language intent")
    .option("--mode <engine>", "terraform (only option for dry-run)", "terraform")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, modelId(), undefined, bedrockCreds());
      await workflow.planOnly(cmd.input, tenant);
    });

  // plan apply
  planCmd
    .command("apply")
    .description("Apply an infrastructure change (new input or patch an existing Terraform dir).")
    .requiredOption("-i, --input <instruction>", "plain-language change description")
    .option("--tf-dir <path>",  "path to existing Terraform directory to patch")
    .option("--mode <engine>",  "aws | terraform", "terraform")
    .action(async (cmd) => {
      const { resolve } = await import("node:path");
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, modelId(), undefined, bedrockCreds());
      if (cmd.tfDir) {
        await workflow.updateExisting(cmd.input, resolve(cmd.tfDir), tenant);
      } else {
        await workflow.applyExisting(cmd.input, tenant);
      }
    });

  // ── default (interactive) ────────────────────────────────────────────────────
  program.action(async () => {
    const tenant = buildTenant();
    await runInteractiveSession(tenant, (region, mid, telemetry) => makeWorkflow(region, mid, telemetry, bedrockCreds()));
  });

  await program.parseAsync(process.argv);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack   = error instanceof Error ? error.stack   : undefined;
  log.error("CLI fatal error", { event: "fatal_error", error: message, stack });
  console.error(`infra failed: ${message}`);
  process.exitCode = 1;
});
