#!/usr/bin/env node
import { Command } from "commander";
import { cwd } from "node:process";
import { ClarifyAgent } from "../agents/clarifyAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { AwsPlannerAgent } from "../agents/awsPlannerAgent";
import { ExecutorAgent } from "../agents/executorAgent";
import { DiagnoseAgent } from "../agents/diagnoseAgent";
import { AskAgent } from "../agents/askAgent";
import { BedrockService } from "../services/bedrockService";
import { TerraformMcpService } from "../services/terraformMcpService";
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

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function makeWorkflow(
  region: string,
  modelId?: string,
  telemetry?: TelemetryCollector,
  bedrockCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): InfraWorkflow {
  const bedrock = new BedrockService(region, modelId, telemetry, bedrockCredentials);
  const clarifyAgent = new ClarifyAgent(bedrock);
  const plannerAgent = new PlannerAgent(bedrock);
  const awsPlannerAgent = new AwsPlannerAgent(bedrock);
  const terraformMcp = new TerraformMcpService(cwd());
  const executorAgent = new ExecutorAgent(terraformMcp);
  const askAgent = new AskAgent(bedrock);
  const diagnoseAgent = new DiagnoseAgent(bedrock);
  const registryClient = new TerraformRegistryClient();
  return new InfraWorkflow(
    clarifyAgent,
    plannerAgent,
    awsPlannerAgent,
    executorAgent,
    diagnoseAgent,
    askAgent,
    registryClient,
    terraformMcp,
    new RateLimiterService(),
    new SubscriptionService(),
    new TracingService(),
  );
}

async function run(): Promise<void> {
  const program = new Command();
  program.name("infra").description("infra-copilot CLI").version("1.0.0");

  // Global options for proper multi-tenant controls.
  program
    .option("--tenant-id <tenantId>", "tenant identifier", process.env.TENANT_ID)
    .option("--user-id <userId>", "user identifier", process.env.USER_ID)
    .option("--subscription <tier>", "free|pro|enterprise", process.env.SUBSCRIPTION_TIER ?? "pro")
    .option("--region <awsRegion>", "AWS region", process.env.AWS_REGION ?? "us-east-1")
    // Bedrock credentials — for all LLM calls (the account where Bedrock models are deployed)
    .option("--bedrock-access-key-id <keyId>", "Access key ID for the Bedrock AWS account", process.env.BEDROCK_ACCESS_KEY_ID)
    .option("--bedrock-secret-access-key <secret>", "Secret access key for the Bedrock AWS account", process.env.BEDROCK_SECRET_ACCESS_KEY)
    .option("--bedrock-session-token <token>", "Session token for the Bedrock AWS account (SSO / temporary credentials)", process.env.BEDROCK_SESSION_TOKEN)
    // Tenant credentials — for the account being investigated/managed (CloudWatch, CloudControl, etc.)
    .option("--aws-access-key-id <keyId>", "Access key ID for the tenant AWS account", process.env.TENANT_AWS_ACCESS_KEY_ID)
    .option("--aws-secret-access-key <secret>", "Secret access key for the tenant AWS account", process.env.TENANT_AWS_SECRET_ACCESS_KEY)
    .option("--aws-session-token <token>", "Session token for the tenant AWS account (SSO / temporary credentials)", process.env.TENANT_AWS_SESSION_TOKEN)
    .option("--log-level <level>", "debug|info|warn|error", getConfiguredLogLevel())
    .option("--tf-dir <path>", "path to existing Terraform directory (triggers update flow)")
    .option("-i, --input <instruction>", "plain-language change description (used with --tf-dir)")
    .option("--engine <engine>", "terraform|aws  — execution engine for create/plan commands", "terraform");

  const tenantService = new TenantService();

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
    logLevel: "debug" | "info" | "warn" | "error";
    tfDir?: string;
    input?: string;
    engine: "terraform" | "aws";
  };

  /** Tenant context — carries the investigated account's credentials. */
  const buildTenant = (): ReturnType<TenantService["buildContext"]> => {
    const opts = program.opts<GlobalOpts>();
    process.env.LOG_LEVEL = opts.logLevel;
    const awsCredentials =
      opts.awsAccessKeyId && opts.awsSecretAccessKey
        ? { accessKeyId: opts.awsAccessKeyId, secretAccessKey: opts.awsSecretAccessKey, sessionToken: opts.awsSessionToken }
        : undefined;
    return tenantService.buildContext({
      tenantId: requiredEnv("TENANT_ID", opts.tenantId),
      userId: requiredEnv("USER_ID", opts.userId),
      subscriptionTier: opts.subscription,
      awsRegion: opts.region,
      awsCredentials,
    });
  };

  /** Bedrock credentials — for the account where LLMs are deployed. */
  const bedrockCreds = (): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined => {
    const opts = program.opts<GlobalOpts>();
    return opts.bedrockAccessKeyId && opts.bedrockSecretAccessKey
      ? { accessKeyId: opts.bedrockAccessKeyId, secretAccessKey: opts.bedrockSecretAccessKey, sessionToken: opts.bedrockSessionToken }
      : undefined;
  };

  program
    .command("create")
    .description("Parse intent, generate plan, ask approval, then execute.")
    .action(async () => {
      const opts = program.opts<{ input?: string; engine: "terraform" | "aws" }>();
      if (!opts.input) {
        console.error("--input <intent> is required for the create command");
        process.exitCode = 1;
        return;
      }
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      if (opts.engine === "aws") {
        await workflow.createWithAwsSdk(opts.input, tenant);
      } else {
        await workflow.createOrUpdate(opts.input, tenant);
      }
    });

  program
    .command("plan")
    .description("Generate and run terraform plan only.")
    .action(async () => {
      const opts = program.opts<{ input?: string }>();
      if (!opts.input) {
        console.error("--input <intent> is required for the plan command");
        process.exitCode = 1;
        return;
      }
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.planOnly(opts.input, tenant);
    });

  program
    .command("update")
    .description("Read an existing Terraform directory, patch files with LLM, then plan & apply.")
    .action(async () => {
      const { resolve } = await import("node:path");
      const opts = program.opts<{ tfDir?: string; input?: string }>();
      if (!opts.tfDir) {
        console.error("--tf-dir <path> is required for the update command");
        process.exitCode = 1;
        return;
      }
      if (!opts.input) {
        console.error("--input <instruction> is required for the update command");
        process.exitCode = 1;
        return;
      }
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.updateExisting(opts.input, resolve(opts.tfDir), tenant);
    });

  program
    .command("apply")
    .description("Generate plan and apply only after confirmation.")
    .action(async () => {
      const opts = program.opts<{ input?: string }>();
      if (!opts.input) {
        console.error("--input <intent> is required for the apply command");
        process.exitCode = 1;
        return;
      }
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.applyExisting(opts.input, tenant);
    });

  program
    .command("ask")
    .description("Answer AWS inventory questions from live AWS account data.")
    .requiredOption("-q, --question <question>", "question about your AWS account")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.ask(cmd.question, tenant);
    });

  program
    .command("debug")
    .description("Collect observability signals from all configured sources and analyze with LLM.")
    .requiredOption("-s, --service <serviceName>", "service / workload name to debug")
    .option("-n, --namespace <namespace>", "Kubernetes namespace (default: default)")
    .option("--since <duration>", "look-back window: 30m | 1h | 6h | 24h (default: 1h)")
    .option("--tail <lines>", "max log lines per source", "50")
    .option("--log-groups <groups>", "comma-separated CloudWatch log group names (overrides auto-discovery)")
    .option("--loki-url <url>", "Loki base URL, e.g. http://loki.monitoring:3100")
    .option("--opensearch-url <url>", "OpenSearch/Elasticsearch base URL, e.g. https://opensearch:9200")
    .option("--opensearch-index <pattern>", "OpenSearch index pattern (default: *)")
    .option("--opensearch-user <user>", "OpenSearch basic-auth username")
    .option("--opensearch-pass <pass>", "OpenSearch basic-auth password")
    .option("--k8s-context <context>", "kubectl context name (default: current context)")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.debug(cmd.service, tenant, {
        namespace: cmd.namespace,
        since: cmd.since,
        tailLines: cmd.tail ? parseInt(cmd.tail, 10) : undefined,
        logGroups: cmd.logGroups ? (cmd.logGroups as string).split(",").map((s: string) => s.trim()) : undefined,
        lokiUrl: cmd.lokiUrl,
        openSearchUrl: cmd.opensearchUrl,
        openSearchIndex: cmd.opensearchIndex,
        openSearchUser: cmd.opensearchUser,
        openSearchPass: cmd.opensearchPass,
        k8sContext: cmd.k8sContext,
      });
    });

  program
    .command("diagnose")
    .description("Ask a plain-English question — auto-discovers the service across k8s, CloudWatch, Loki, and OpenSearch.")
    .requiredOption("-q, --question <question>", 'e.g. "why is mimir crashing?"')
    .option("--k8s-context <context>", "kubectl context name (default: current context)")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.diagnose(cmd.question, tenant, cmd.k8sContext);
    });

  // Default action — if --tf-dir is set, run update flow; otherwise launch interactive session.
  program.action(async () => {
    const opts = program.opts<{ tfDir?: string; input?: string }>();
    const tenant = buildTenant();
    if (opts.tfDir) {
      const { resolve } = await import("node:path");
      const instruction = opts.input ?? "";
      if (!instruction) {
        console.error("--input <instruction> is required when using --tf-dir");
        process.exitCode = 1;
        return;
      }
      const workflow = makeWorkflow(tenant.awsRegion, undefined, undefined, bedrockCreds());
      await workflow.updateExisting(instruction, resolve(opts.tfDir), tenant);
      return;
    }
    await runInteractiveSession(tenant, (region, modelId, telemetry) => makeWorkflow(region, modelId, telemetry, bedrockCreds()));
  });

  await program.parseAsync(process.argv);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  log.error("CLI fatal error", {
    event: "fatal_error",
    error: message,
    stack,
  });
  console.error(`infra-copilot failed: ${message}`);
  process.exitCode = 1;
});
