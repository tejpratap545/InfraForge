#!/usr/bin/env node
import { Command } from "commander";
import { cwd } from "node:process";
import { IntentAgent } from "../agents/intentAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { AwsPlannerAgent } from "../agents/awsPlannerAgent";
import { ExecutorAgent } from "../agents/executorAgent";
import { DebuggerAgent } from "../agents/debuggerAgent";
import { DiagnoseAgent } from "../agents/diagnoseAgent";
import { AskAgent } from "../agents/askAgent";
import { DebugAggregator } from "../providers/debugAggregator";
import { ServiceDiscovery } from "../services/serviceDiscovery";
import { AwsInventoryService } from "../services/awsInventoryService";
import { AwsMetricsService } from "../services/awsMetricsService";
import { K8sInventoryService } from "../services/k8sInventoryService";
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

function makeWorkflow(region: string, modelId?: string, telemetry?: TelemetryCollector): InfraWorkflow {
  const bedrock = new BedrockService(region, modelId, telemetry);
  const intentAgent = new IntentAgent(bedrock);
  const plannerAgent = new PlannerAgent(bedrock);
  const awsPlannerAgent = new AwsPlannerAgent(bedrock);
  const terraformMcp = new TerraformMcpService(cwd());
  const executorAgent = new ExecutorAgent(terraformMcp);
  const aggregator = new DebugAggregator();
  const debuggerAgent = new DebuggerAgent(aggregator, bedrock);
  const askAgent = new AskAgent(bedrock);
  const awsInventory = new AwsInventoryService();
  const awsMetrics = new AwsMetricsService();
  const k8sInventory = new K8sInventoryService();
  const diagnoseAgent = new DiagnoseAgent(bedrock, new ServiceDiscovery(), aggregator, k8sInventory, awsMetrics);
  const registryClient = new TerraformRegistryClient();
  return new InfraWorkflow(
    intentAgent,
    plannerAgent,
    awsPlannerAgent,
    executorAgent,
    debuggerAgent,
    diagnoseAgent,
    askAgent,
    awsInventory,
    awsMetrics,
    k8sInventory,
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
    .option("--log-level <level>", "debug|info|warn|error", getConfiguredLogLevel())
    .option("--tf-dir <path>", "path to existing Terraform directory (triggers update flow)")
    .option("-i, --input <instruction>", "plain-language change description (used with --tf-dir)")
    .option("--engine <engine>", "terraform|aws  — execution engine for create/plan commands", "terraform");

  const tenantService = new TenantService();

  const buildTenant = (): ReturnType<TenantService["buildContext"]> => {
    const opts = program.opts<{
      tenantId?: string;
      userId?: string;
      subscription: "free" | "pro" | "enterprise";
      region: string;
      logLevel: "debug" | "info" | "warn" | "error";
      tfDir?: string;
      input?: string;
      engine: "terraform" | "aws";
    }>();
    process.env.LOG_LEVEL = opts.logLevel;
    return tenantService.buildContext({
      tenantId: requiredEnv("TENANT_ID", opts.tenantId),
      userId: requiredEnv("USER_ID", opts.userId),
      subscriptionTier: opts.subscription,
      awsRegion: opts.region,
    });
  };

  program
    .command("create")
    .description("Parse intent, generate plan, ask approval, then execute.")
    .requiredOption("-i, --input <intent>", "natural language input")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const { engine } = program.opts<{ engine: "terraform" | "aws" }>();
      const workflow = makeWorkflow(tenant.awsRegion);
      if (engine === "aws") {
        await workflow.createWithAwsSdk(cmd.input, tenant);
      } else {
        await workflow.createOrUpdate(cmd.input, tenant);
      }
    });

  program
    .command("plan")
    .description("Generate and run terraform plan only.")
    .requiredOption("-i, --input <intent>", "natural language input")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion);
      await workflow.planOnly(cmd.input, tenant);
    });

  program
    .command("update")
    .description("Read an existing Terraform directory, patch files with LLM, then plan & apply.")
    .requiredOption("-d, --tf-dir <path>", "path to existing Terraform directory")
    .requiredOption("-i, --input <instruction>", "plain-language change description")
    .action(async (cmd) => {
      const { resolve } = await import("node:path");
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion);
      await workflow.updateExisting(cmd.input, resolve(cmd.tfDir), tenant);
    });

  program
    .command("apply")
    .description("Generate plan and apply only after confirmation.")
    .requiredOption("-i, --input <intent>", "natural language input")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion);
      await workflow.applyExisting(cmd.input, tenant);
    });

  program
    .command("ask")
    .description("Answer AWS inventory questions from live AWS account data.")
    .requiredOption("-q, --question <question>", "question about your AWS account")
    .action(async (cmd) => {
      const tenant = buildTenant();
      const workflow = makeWorkflow(tenant.awsRegion);
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
      const workflow = makeWorkflow(tenant.awsRegion);
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
      const workflow = makeWorkflow(tenant.awsRegion);
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
      const workflow = makeWorkflow(tenant.awsRegion);
      await workflow.updateExisting(instruction, resolve(opts.tfDir), tenant);
      return;
    }
    await runInteractiveSession(tenant, (region, modelId, telemetry) => makeWorkflow(region, modelId, telemetry));
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
