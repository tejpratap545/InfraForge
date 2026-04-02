import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function kubectl(args: string[], ctxArgs: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", [...args, ...ctxArgs], { timeout: timeoutMs });
  return stdout.trim();
}

export interface ServiceNode {
  serviceName: string;
  namespace: string;
  /** Pod names backing this service. */
  pods: string[];
  /** "root" = the service being diagnosed; "dependency" = discovered upstream/downstream. */
  role: "root" | "dependency";
  /** 0 = root, 1 = direct dep, 2 = transitive dep. */
  hop: number;
}

export interface DependencyGraph {
  nodes: ServiceNode[];
  edges: Array<{ from: string; to: string }>;
}

/**
 * Builds a pod-level dependency graph for a given Kubernetes service.
 *
 * Discovery strategy:
 *  1. Resolve pod names via the K8s Service's label selector.
 *  2. Read the first pod's env vars — Kubernetes auto-injects
 *     `<SVC_NAME>_SERVICE_HOST` for every Service in the namespace, so
 *     those keys reveal what other services this pod depends on.
 *  3. Recurse up to `maxHops` hops.
 */
export class K8sDependencyTracer {
  async build(
    rootService: string,
    namespace: string,
    k8sContext?: string,
    maxHops = 2,
  ): Promise<DependencyGraph> {
    const ctxArgs = k8sContext ? ["--context", k8sContext] : [];
    const visited = new Set<string>();
    const nodes: ServiceNode[] = [];
    const edges: Array<{ from: string; to: string }> = [];

    await this.traverse(rootService, namespace, ctxArgs, 0, maxHops, visited, nodes, edges);
    return { nodes, edges };
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private async traverse(
    svcName: string,
    namespace: string,
    ctxArgs: string[],
    hop: number,
    maxHops: number,
    visited: Set<string>,
    nodes: ServiceNode[],
    edges: Array<{ from: string; to: string }>,
  ): Promise<void> {
    if (visited.has(svcName)) return;
    visited.add(svcName);

    const pods = await this.resolvePodsForService(svcName, namespace, ctxArgs);
    nodes.push({ serviceName: svcName, namespace, pods, role: hop === 0 ? "root" : "dependency", hop });

    if (hop >= maxHops || pods.length === 0) return;

    const deps = await this.extractDependencies(pods[0], namespace, ctxArgs, svcName);
    await Promise.all(
      deps.map(async (dep) => {
        edges.push({ from: svcName, to: dep });
        await this.traverse(dep, namespace, ctxArgs, hop + 1, maxHops, visited, nodes, edges);
      }),
    );
  }

  /**
   * Finds pod names for a service:
   *  1. Exact K8s Service lookup → use its selector to find pods.
   *  2. Fallback: name-prefix scan across all pods in namespace.
   */
  private async resolvePodsForService(
    svcName: string,
    namespace: string,
    ctxArgs: string[],
  ): Promise<string[]> {
    try {
      const raw = await kubectl(["get", "svc", svcName, "-n", namespace, "-o", "json"], ctxArgs);
      const svc = JSON.parse(raw) as { spec?: { selector?: Record<string, string> } };
      const sel = svc.spec?.selector ?? {};
      if (Object.keys(sel).length > 0) {
        const labelSel = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(",");
        const raw2 = await kubectl(
          ["get", "pods", "-n", namespace, "-l", labelSel, "-o", "jsonpath={.items[*].metadata.name}"],
          ctxArgs,
        );
        const pods = raw2.split(/\s+/).filter(Boolean);
        if (pods.length > 0) return pods;
      }
    } catch {
      // Service not found by exact name — fall through to prefix scan.
    }

    try {
      const raw = await kubectl(["get", "pods", "-n", namespace, "-o", "json"], ctxArgs);
      const parsed = JSON.parse(raw) as { items: Array<{ metadata: { name: string } }> };
      return parsed.items.map((p) => p.metadata.name).filter((n) => n.includes(svcName));
    } catch {
      return [];
    }
  }

  /**
   * Reads a pod's env vars and extracts service dependency names from:
   *  - `<SVC>_SERVICE_HOST` / `<SVC>_SERVICE_PORT` — auto-injected by K8s
   *  - `<SVC>_HOST`, `<SVC>_URL`, `<SVC>_ADDR`, `<SVC>_ADDRESS` — common explicit patterns
   */
  private async extractDependencies(
    podName: string,
    namespace: string,
    ctxArgs: string[],
    excludeService: string,
  ): Promise<string[]> {
    try {
      const raw = await kubectl(
        ["get", "pod", podName, "-n", namespace, "-o", "jsonpath={.spec.containers[0].env}"],
        ctxArgs,
      );
      if (!raw || raw === "null") return [];

      const envArr = JSON.parse(raw) as Array<{ name: string; value?: string }>;
      const deps = new Set<string>();

      for (const e of envArr) {
        const m = e.name.match(/^(.+?)_(?:SERVICE_HOST|SERVICE_PORT|HOST|URL|ADDR|ADDRESS)$/i);
        if (!m) continue;
        const dep = m[1].toLowerCase().replace(/_/g, "-");
        // Skip well-known non-service names and the service we came from.
        if (dep !== excludeService && dep.length > 2 && !/^(kubernetes|kube|localhost)$/.test(dep)) {
          deps.add(dep);
        }
      }

      return [...deps];
    } catch {
      return [];
    }
  }
}
