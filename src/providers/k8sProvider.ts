import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IDebugProvider } from "./IDebugProvider";
import { DebugSignal, DebugOptions, DebugSeverity } from "../types";

const execFileAsync = promisify(execFile);

async function kubectl(args: string[], timeoutMs = 15000): Promise<string> {
  const { stdout } = await execFileAsync("kubectl", args, { timeout: timeoutMs });
  return stdout;
}

function detectSeverity(msg: string): DebugSeverity {
  const lower = msg.toLowerCase();
  if (/oomkilled|evicted|crashloopbackoff|panic|fatal/.test(lower)) return "critical";
  if (/error|backoff|failed|failedscheduling|unhealthy/.test(lower)) return "error";
  if (/warn|restarted|pending|throttl|slow/.test(lower)) return "warn";
  return "info";
}

interface PodItem {
  metadata: { name: string; namespace: string };
  status: { phase: string; containerStatuses?: Array<{ restartCount: number; state: Record<string, unknown> }> };
}

export class K8sProvider implements IDebugProvider {
  readonly name = "Kubernetes";

  async isAvailable(options: DebugOptions): Promise<boolean> {
    try {
      const ctxArgs = options.k8sContext ? ["--context", options.k8sContext] : [];
      await kubectl(["cluster-info", "--request-timeout=5s", ...ctxArgs], 8000);
      return true;
    } catch {
      return false;
    }
  }

  async fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]> {
    try {
      const ns = options.namespace ?? "default";
      const since = options.since ?? "1h";
      const tail = String(options.tailLines ?? 50);
      const ctxArgs = options.k8sContext ? ["--context", options.k8sContext] : [];

      const pods = await this.listPods(serviceName, ns, ctxArgs);
      if (pods.length === 0) return [];

      const signals: DebugSignal[] = [];

      // Pod status signals (restart counts, crash state).
      for (const pod of pods) {
        for (const cs of pod.status.containerStatuses ?? []) {
          if (cs.restartCount > 0) {
            const stateKey = Object.keys(cs.state)[0] ?? "unknown";
            const severity: DebugSeverity = cs.restartCount >= 5 ? "critical" : cs.restartCount >= 2 ? "error" : "warn";
            signals.push({
              source: "k8s-pod-logs",
              severity,
              timestamp: new Date().toISOString(),
              resourceName: pod.metadata.name,
              payload: `Pod ${pod.metadata.name} has restarted ${cs.restartCount} time(s). Current state: ${stateKey}.`,
            });
          }
        }
      }

      // Pod logs + events in parallel.
      await Promise.all(
        pods.slice(0, 5).map(async (pod) => {
          await Promise.all([
            this.fetchPodLogs(pod.metadata.name, ns, since, tail, ctxArgs, signals),
            this.fetchPodEvents(pod.metadata.name, ns, ctxArgs, signals),
          ]);
        }),
      );

      return signals.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    } catch {
      return [];
    }
  }

  private async listPods(
    serviceName: string,
    ns: string,
    ctxArgs: string[],
  ): Promise<PodItem[]> {
    // Try app label first, then fall back to a name prefix search.
    const labelSelectors = [`app=${serviceName}`, `app.kubernetes.io/name=${serviceName}`];

    for (const selector of labelSelectors) {
      try {
        const raw = await kubectl([
          "get", "pods",
          "-n", ns,
          "-l", selector,
          "-o", "json",
          ...ctxArgs,
        ]);
        const parsed = JSON.parse(raw) as { items: PodItem[] };
        if (parsed.items.length > 0) return parsed.items;
      } catch {
        // Try next selector.
      }
    }

    // Fall back: list all pods and filter by name prefix.
    try {
      const raw = await kubectl(["get", "pods", "-n", ns, "-o", "json", ...ctxArgs]);
      const parsed = JSON.parse(raw) as { items: PodItem[] };
      return parsed.items.filter((p) =>
        p.metadata.name.startsWith(serviceName) || p.metadata.name.includes(serviceName),
      );
    } catch {
      return [];
    }
  }

  private async fetchPodLogs(
    podName: string,
    ns: string,
    since: string,
    tail: string,
    ctxArgs: string[],
    out: DebugSignal[],
  ): Promise<void> {
    try {
      const logs = await kubectl([
        "logs", podName,
        "-n", ns,
        `--tail=${tail}`,
        `--since=${since}`,
        "--timestamps=true",
        ...ctxArgs,
      ]);
      for (const line of logs.split("\n").filter(Boolean)) {
        // kubectl --timestamps prefixes lines with RFC3339 timestamp.
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)/s);
        const timestamp = tsMatch ? tsMatch[1] : undefined;
        const message = tsMatch ? tsMatch[2] : line;
        out.push({
          source: "k8s-pod-logs",
          severity: detectSeverity(message),
          timestamp,
          resourceName: podName,
          payload: message.trim(),
        });
      }
    } catch {
      // Pod may be in a state where logs are unavailable.
    }
  }

  private async fetchPodEvents(
    podName: string,
    ns: string,
    ctxArgs: string[],
    out: DebugSignal[],
  ): Promise<void> {
    try {
      const raw = await kubectl([
        "get", "events",
        "-n", ns,
        `--field-selector=involvedObject.name=${podName}`,
        "-o", "json",
        ...ctxArgs,
      ]);
      const parsed = JSON.parse(raw) as {
        items: Array<{
          lastTimestamp?: string;
          eventTime?: string;
          reason: string;
          message: string;
          type: string;
        }>;
      };
      for (const ev of parsed.items) {
        const severity: DebugSeverity = ev.type === "Warning" ? "warn" : "info";
        out.push({
          source: "k8s-events",
          severity: detectSeverity(ev.reason + " " + ev.message) === "info" ? severity : detectSeverity(ev.reason + " " + ev.message),
          timestamp: ev.lastTimestamp ?? ev.eventTime,
          resourceName: podName,
          payload: `[${ev.reason}] ${ev.message}`,
        });
      }
    } catch {
      // Skip events if unavailable.
    }
  }
}
