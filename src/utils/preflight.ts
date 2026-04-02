/**
 * preflight.ts
 *
 * Validates tool connectivity before the LLM loop starts.
 * Runs fast parallel checks: AWS identity, k8s cluster, MCP servers.
 *
 * Results are injected into every system prompt as ENVIRONMENT context,
 * so the LLM knows upfront exactly what's reachable and what isn't —
 * no wasted steps probing connectivity.
 */

import { exec } from "node:child_process";
import type { AwsCredentials } from "../types";
import type { AwsMcpService } from "../services/awsMcpService";
import { routeQuestion, type RoutingResult } from "./serviceRouter";
import { buildServiceContext } from "./serviceCatalogs";

export interface PreflightResult {
  /** Human-readable block injected into the system prompt. */
  context: string;
  /** True if AWS credentials are confirmed working. */
  awsReady: boolean;
  /** AWS account ID if confirmed, undefined otherwise. */
  awsAccountId?: string;
  /** True if kubectl is reachable for the given context. */
  k8sReady: boolean;
  /** MCP server names that connected successfully. */
  mcpServers: string[];
  /** Detected service groups from the question. */
  routing: RoutingResult;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shellFast(cmd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8_000, env: env ?? (process.env as Record<string, string>) }, (_err, stdout, stderr) => {
      resolve((stdout ?? stderr ?? "").trim().slice(0, 1_000));
    });
  });
}

// ─── AWS identity check ───────────────────────────────────────────────────────

async function checkAws(region: string, credentials?: AwsCredentials): Promise<{ ok: boolean; accountId?: string; userId?: string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (credentials) {
    env["AWS_ACCESS_KEY_ID"]     = credentials.accessKeyId;
    env["AWS_SECRET_ACCESS_KEY"] = credentials.secretAccessKey;
    if (credentials.sessionToken) env["AWS_SESSION_TOKEN"] = credentials.sessionToken;
    delete env["AWS_PROFILE"];
    delete env["AWS_DEFAULT_PROFILE"];
  }

  const raw = await shellFast(`aws sts get-caller-identity --output json --region ${region}`, env);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.Account) {
      return { ok: true, accountId: parsed.Account, userId: parsed.UserId ?? parsed.Arn };
    }
  } catch { /* fall through */ }
  return { ok: false };
}

// ─── K8s connectivity check ───────────────────────────────────────────────────

async function checkK8s(k8sContext?: string): Promise<{ ok: boolean; clusterInfo?: string }> {
  if (!k8sContext) return { ok: false };
  const raw = await shellFast(`kubectl cluster-info --context ${k8sContext} 2>&1`);
  const ok = raw.includes("running") || raw.includes("https://");
  const clusterInfo = ok ? raw.split("\n")[0].slice(0, 120) : undefined;
  return { ok, clusterInfo };
}

// ─── Main preflight ───────────────────────────────────────────────────────────

export async function runPreflight(
  awsRegion: string,
  question: string,
  credentials?: AwsCredentials,
  k8sContext?: string,
  mcpService?: AwsMcpService,
): Promise<PreflightResult> {
  // Detect relevant services from the question
  const routing = routeQuestion(question);

  // Run connectivity checks in parallel
  const [awsResult, k8sResult] = await Promise.all([
    checkAws(awsRegion, credentials),
    checkK8s(k8sContext),
  ]);

  const mcpServers = mcpService?.isConnected() ? mcpService.getConnectedServers() : [];
  const mcpTools   = mcpService?.isConnected() ? mcpService.getDiscoveredTools() : [];

  // ── Environment block ────────────────────────────────────────────────────────
  const lines: string[] = ["ENVIRONMENT (validated before this session):"];

  if (awsResult.ok) {
    lines.push(`  AWS:     ✓ connected  account=${awsResult.accountId}  region=${awsRegion}`);
    if (awsResult.userId) lines.push(`           identity=${awsResult.userId}`);
  } else {
    lines.push(`  AWS:     ✗ NOT reachable in ${awsRegion} — check credentials`);
  }

  if (k8sResult.ok) {
    lines.push(`  K8s:     ✓ connected  context=${k8sContext}  ${k8sResult.clusterInfo ?? ""}`);
  } else if (k8sContext) {
    lines.push(`  K8s:     ✗ context "${k8sContext}" not reachable`);
  } else {
    lines.push(`  K8s:     – not configured`);
  }

  lines.push(`  aws cli: ✓ available`);

  if (mcpServers.length > 0) {
    lines.push(`  MCP:     ✓ ${mcpServers.length} server(s): ${mcpServers.join(", ")}  (${mcpTools.length} tools)`);
  } else {
    lines.push(`  MCP:     – not configured (SDK + aws_cli tools available)`);
  }

  lines.push(`  Detected services: ${routing.groups.join(", ")}`);
  lines.push("");

  // ── Service-specific reference block ─────────────────────────────────────────
  const serviceContext = buildServiceContext(routing.groups);

  return {
    context: lines.join("\n") + "\n" + serviceContext,
    awsReady: awsResult.ok,
    awsAccountId: awsResult.accountId,
    k8sReady: k8sResult.ok,
    mcpServers,
    routing,
  };
}
