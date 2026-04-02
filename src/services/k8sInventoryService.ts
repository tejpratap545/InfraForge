import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AskK8sQuery } from "../types";

const execFileAsync = promisify(execFile);

async function kubectl(args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function awsCli(args: string[], timeoutMs = 30_000): Promise<void> {
  await execFileAsync("aws", args, { timeout: timeoutMs });
}

/** Maps common plural/singular aliases to the canonical kubectl resource name. */
const RESOURCE_ALIASES: Record<string, string> = {
  pod: "pods", po: "pods",
  namespace: "namespaces", ns: "namespaces",
  deployment: "deployments", deploy: "deployments",
  service: "services", svc: "services",
  node: "nodes", no: "nodes",
  replicaset: "replicasets", rs: "replicasets",
  statefulset: "statefulsets", sts: "statefulsets",
  daemonset: "daemonsets", ds: "daemonsets",
  ingress: "ingresses", ing: "ingresses",
  configmap: "configmaps", cm: "configmaps",
  secret: "secrets",
  pvc: "persistentvolumeclaims", persistentvolumeclaim: "persistentvolumeclaims",
  pv: "persistentvolumes", persistentvolume: "persistentvolumes",
  cronjob: "cronjobs", cj: "cronjobs",
  job: "jobs",
  hpa: "horizontalpodautoscalers",
  event: "events",
};

function resolveResource(name: string): string {
  return RESOURCE_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
}

// ─── Per-resource formatters ───────────────────────────────────────────────────

function formatPods(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const status = item["status"] as Record<string, unknown>;
    const cs = (status["containerStatuses"] as Array<Record<string, unknown>> | undefined) ?? [];
    const restarts = cs.reduce((n, c) => n + ((c["restartCount"] as number) ?? 0), 0);
    const ready = cs.filter((c) => c["ready"] === true).length;
    return `  ${(meta["namespace"] as string).padEnd(20)} ${(meta["name"] as string).padEnd(50)} ` +
      `${(status["phase"] as string ?? "Unknown").padEnd(12)} ready=${ready}/${cs.length} restarts=${restarts}`;
  });
}

function formatNamespaces(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const status = item["status"] as Record<string, unknown>;
    return `  ${(meta["name"] as string).padEnd(40)} status=${status["phase"] as string ?? "Active"}`;
  });
}

function formatDeployments(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const spec = item["spec"] as Record<string, unknown>;
    const status = item["status"] as Record<string, unknown>;
    return `  ${(meta["namespace"] as string).padEnd(20)} ${(meta["name"] as string).padEnd(40)} ` +
      `desired=${spec["replicas"] ?? 1}  ready=${status["readyReplicas"] ?? 0}  available=${status["availableReplicas"] ?? 0}`;
  });
}

function formatNodes(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const status = item["status"] as Record<string, unknown>;
    const conditions = (status["conditions"] as Array<Record<string, unknown>> | undefined) ?? [];
    const ready = conditions.find((c) => c["type"] === "Ready")?.["status"] ?? "Unknown";
    const cap = status["capacity"] as Record<string, unknown> | undefined;
    return `  ${(meta["name"] as string).padEnd(50)} Ready=${ready as string}  cpu=${cap?.["cpu"]}  mem=${cap?.["memory"]}`;
  });
}

function formatServices(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const spec = item["spec"] as Record<string, unknown>;
    const ports = ((spec["ports"] as Array<Record<string, unknown>>) ?? [])
      .map((p) => `${p["port"]}/${p["protocol"]}`)
      .join(",");
    return `  ${(meta["namespace"] as string).padEnd(20)} ${(meta["name"] as string).padEnd(40)} ` +
      `type=${spec["type"]}  clusterIP=${spec["clusterIP"]}  ports=${ports}`;
  });
}

function formatStatefulSets(items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const spec = item["spec"] as Record<string, unknown>;
    const status = item["status"] as Record<string, unknown>;
    return `  ${(meta["namespace"] as string).padEnd(20)} ${(meta["name"] as string).padEnd(40)} ` +
      `desired=${spec["replicas"] ?? 1}  ready=${status["readyReplicas"] ?? 0}`;
  });
}

function formatGeneric(resourceType: string, items: Record<string, unknown>[]): string[] {
  return items.map((item) => {
    const meta = item["metadata"] as Record<string, unknown>;
    const ns = meta["namespace"] ? `${meta["namespace"] as string}/` : "";
    return `  ${ns}${meta["name"] as string}`;
  });
}

function formatItems(resourceType: string, items: Record<string, unknown>[]): string[] {
  switch (resourceType) {
    case "pods":                     return formatPods(items);
    case "namespaces":               return formatNamespaces(items);
    case "deployments":              return formatDeployments(items);
    case "nodes":                    return formatNodes(items);
    case "services":                 return formatServices(items);
    case "statefulsets":             return formatStatefulSets(items);
    default:                         return formatGeneric(resourceType, items);
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class K8sInventoryService {
  /**
   * Run kubectl to list k8s resources and return a formatted text block for the LLM.
   */
  async query(q: AskK8sQuery, region?: string): Promise<string> {
    // If a cluster name is provided, ensure kubeconfig is set up for it
    if (q.clusterName && region) {
      await this.ensureKubeconfig(q.clusterName, region);
    }

    const sections: string[] = [];

    for (const rawResource of q.resources) {
      const resource = resolveResource(rawResource);
      const section = await this.fetchResource(resource, q.namespace);
      sections.push(section);
    }

    return sections.join("\n\n");
  }

  private async ensureKubeconfig(clusterName: string, region: string): Promise<void> {
    try {
      await awsCli(["eks", "update-kubeconfig", "--name", clusterName, "--region", region]);
    } catch {
      // Kubeconfig may already be set up — continue
    }
  }

  private async fetchResource(resource: string, namespace?: string): Promise<string> {
    try {
      const args: string[] = ["get", resource];

      if (resource === "namespaces" || resource === "nodes" || resource === "persistentvolumes") {
        // These are cluster-scoped, not namespaced
      } else if (namespace && namespace !== "all") {
        args.push("-n", namespace);
      } else {
        args.push("--all-namespaces");
      }

      args.push("-o", "json");

      const raw = await kubectl(args);
      const parsed = JSON.parse(raw) as { items?: Record<string, unknown>[] };
      const items = parsed.items ?? [];

      const header = `Kubernetes ${resource.toUpperCase()} (${items.length} total):`;
      if (items.length === 0) {
        return `${header}\n  (none found)`;
      }

      const rows = formatItems(resource, items);
      return `${header}\n${rows.join("\n")}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("command not found") || msg.includes("ENOENT")) {
        return `Kubernetes ${resource}: kubectl not found in PATH.`;
      }
      if (msg.includes("connection refused") || msg.includes("Unable to connect")) {
        return `Kubernetes ${resource}: cannot reach cluster. Check kubectl context.`;
      }
      return `Kubernetes ${resource}: ${msg.split("\n")[0]}`;
    }
  }
}
