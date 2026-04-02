import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloudWatchService } from "./cloudWatchService";
import { K8sDiscovery, PodSummary, DiscoveryResult } from "../types";

const cw = new CloudWatchService();

const execFileAsync = promisify(execFile);

// ─── Kubernetes ─────────────────────────────────────────────────────────────

interface RawPod {
  metadata: { name: string; namespace: string };
  status: {
    phase?: string;
    containerStatuses?: Array<{
      ready: boolean;
      restartCount: number;
      state?: Record<string, { reason?: string }>;
      lastState?: Record<string, { reason?: string }>;
    }>;
    conditions?: Array<{ type: string; reason?: string; message?: string }>;
  };
}

function classifyPod(pod: RawPod): PodSummary {
  const cs = pod.status.containerStatuses?.[0];
  const stateKey = cs?.state ? Object.keys(cs.state)[0] : undefined;
  const reason =
    cs?.state?.[stateKey ?? ""]?.reason ??
    cs?.lastState?.[Object.keys(cs.lastState ?? {})[0] ?? ""]?.reason;

  return {
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    phase: pod.status.phase ?? "Unknown",
    ready: cs?.ready ?? false,
    restarts: cs?.restartCount ?? 0,
    containerState: stateKey,
    reason,
  };
}

async function discoverK8s(
  serviceName: string,
  k8sContext?: string,
): Promise<K8sDiscovery[]> {
  const ctxArgs = k8sContext ? ["--context", k8sContext] : [];
  try {
    const { stdout } = await execFileAsync(
      "kubectl",
      ["get", "pods", "--all-namespaces", "-o", "json", ...ctxArgs],
      { timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout) as { items: RawPod[] };
    const needle = serviceName.toLowerCase();

    // Match pods whose name or any label value contains the service name.
    const matched = parsed.items.filter((p) =>
      p.metadata.name.toLowerCase().includes(needle),
    );

    if (matched.length === 0) return [];

    // Group by namespace.
    const byNs = new Map<string, RawPod[]>();
    for (const pod of matched) {
      const ns = pod.metadata.namespace;
      if (!byNs.has(ns)) byNs.set(ns, []);
      byNs.get(ns)!.push(pod);
    }

    const results: K8sDiscovery[] = [];
    for (const [namespace, pods] of byNs) {
      const summaries = pods.map(classifyPod);
      results.push({
        namespace,
        crashingPods: summaries.filter(
          (s) =>
            s.reason === "CrashLoopBackOff" ||
            s.reason === "OOMKilled" ||
            s.reason === "Error" ||
            (s.phase !== "Pending" && !s.ready && s.restarts > 0),
        ),
        pendingPods: summaries.filter((s) => s.phase === "Pending"),
        runningPods: summaries.filter((s) => s.phase === "Running" && s.ready),
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ─── CloudWatch Log Groups ───────────────────────────────────────────────────

async function discoverCWLogGroups(
  serviceName: string,
  awsRegion: string,
): Promise<string[]> {
  try {
    return await cw.discoverLogGroups(serviceName, awsRegion);
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export class ServiceDiscovery {
  async discover(
    serviceName: string,
    awsRegion: string,
    k8sContext?: string,
  ): Promise<DiscoveryResult> {
    // Run all discovery in parallel.
    const [k8s, cloudWatchLogGroups] = await Promise.all([
      discoverK8s(serviceName, k8sContext),
      discoverCWLogGroups(serviceName, awsRegion),
    ]);

    // Pull Loki / OpenSearch from env vars — common in k8s-deployed tooling.
    const lokiUrl = process.env["LOKI_URL"];
    const openSearchUrl = process.env["OPENSEARCH_URL"];
    const openSearchIndex = process.env["OPENSEARCH_INDEX"];
    const openSearchUser = process.env["OPENSEARCH_USER"];
    const openSearchPass = process.env["OPENSEARCH_PASS"];

    const summaryLines = buildSummaryLines(
      k8s,
      cloudWatchLogGroups,
      lokiUrl,
      openSearchUrl,
    );

    return {
      k8s,
      cloudWatchLogGroups,
      lokiUrl,
      openSearchUrl,
      openSearchIndex,
      openSearchUser,
      openSearchPass,
      summaryLines,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSummaryLines(
  k8s: K8sDiscovery[],
  logGroups: string[],
  lokiUrl: string | undefined,
  openSearchUrl: string | undefined,
): string[] {
  const lines: string[] = [];

  if (k8s.length > 0) {
    for (const ns of k8s) {
      const total = ns.crashingPods.length + ns.pendingPods.length + ns.runningPods.length;
      const parts: string[] = [];
      if (ns.crashingPods.length > 0)
        parts.push(`${ns.crashingPods.length} crashing`);
      if (ns.pendingPods.length > 0)
        parts.push(`${ns.pendingPods.length} pending`);
      if (ns.runningPods.length > 0)
        parts.push(`${ns.runningPods.length} running`);
      lines.push(
        `  [FOUND] Kubernetes    namespace=${ns.namespace}  ${total} pod(s)  (${parts.join(", ")})`,
      );
    }
  } else {
    lines.push("  [SKIP]  Kubernetes    no matching pods found (kubectl unavailable or service not in cluster)");
  }

  if (logGroups.length > 0) {
    lines.push(
      `  [FOUND] CloudWatch    ${logGroups.length} log group(s): ${logGroups.slice(0, 3).join(", ")}${logGroups.length > 3 ? ` +${logGroups.length - 3} more` : ""}`,
    );
  } else {
    lines.push("  [SKIP]  CloudWatch    no matching log groups (check AWS credentials / region)");
  }

  if (lokiUrl) {
    lines.push(`  [FOUND] Loki          ${lokiUrl}`);
  } else {
    lines.push("  [SKIP]  Loki          not configured  (set LOKI_URL env var to enable)");
  }

  if (openSearchUrl) {
    lines.push(`  [FOUND] OpenSearch    ${openSearchUrl}`);
  } else {
    lines.push("  [SKIP]  OpenSearch    not configured  (set OPENSEARCH_URL env var to enable)");
  }

  return lines;
}
