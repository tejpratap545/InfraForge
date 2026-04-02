/**
 * awsMcpService.ts
 *
 * Multi-server AWS MCP client.
 *
 * Connects to one or more awslabs MCP servers simultaneously, merges their
 * tool catalogs, and routes mcp_tool() calls to the right server automatically.
 *
 * ── QUICK START ──────────────────────────────────────────────────────────────
 *
 * Add any combination of the well-known servers (uses default uvx commands):
 *
 *   AWS_MCP_SERVERS=cloudwatch,cloudtrail
 *   AWS_PROFILE=my-profile
 *   AWS_REGION=ap-southeast-1
 *
 * Or configure individual servers explicitly:
 *
 *   AWS_MCP_SERVERS=cloudwatch,ecs
 *   AWS_MCP_CLOUDWATCH_COMMAND=uvx awslabs.cloudwatch-mcp-server@latest
 *   AWS_MCP_ECS_COMMAND=uvx --from awslabs-ecs-mcp-server ecs-mcp-server
 *
 * Or point at an HTTP endpoint (managed / Docker):
 *
 *   AWS_MCP_SERVERS=cloudwatch
 *   AWS_MCP_CLOUDWATCH_URL=http://localhost:8091/mcp
 *
 * Backward-compatible single-server env vars still work:
 *
 *   AWS_MCP_URL=http://localhost:8090/mcp          (single HTTP server)
 *   AWS_MCP_TRANSPORT=stdio                        (single stdio server)
 *   AWS_MCP_COMMAND=uvx awslabs.cloudwatch-mcp-server@latest
 *
 * ── WELL-KNOWN SERVER NAMES ──────────────────────────────────────────────────
 *
 *   cloudwatch   → uvx awslabs.cloudwatch-mcp-server@latest
 *                  Tools: get_metric_data, analyze_metric, get_active_alarms,
 *                         get_alarm_history, execute_log_insights_query,
 *                         analyze_log_group, describe_log_groups
 *
 *   cloudtrail   → uvx awslabs.cloudtrail-mcp-server@latest
 *                  Tools: lookup_events, lake_query (recent API calls, deploys)
 *
 *   ecs          → uvx --from awslabs-ecs-mcp-server ecs-mcp-server
 *                  Tools: ECS service/task describe & management
 *
 *   eks          → uvx awslabs.eks-mcp-server@latest
 *                  Tools: Kubernetes cluster management
 *
 *   iac          → uvx awslabs.aws-iac-mcp-server@latest
 *                  Tools: CloudFormation validation, deployment failure analysis
 *
 *   iam          → uvx awslabs.iam-mcp-server@latest
 *                  Tools: IAM role/policy inspection, permission simulation
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../utils/logging";

const execAsync = promisify(execCb);

// ─── Command resolution ───────────────────────────────────────────────────────

/**
 * Directories appended to PATH when spawning MCP child processes.
 * Covers common uv/uvx install locations that the Node.js process may not have.
 */
const EXTRA_PATH_DIRS = [
  join(homedir(), ".local", "bin"),   // uv default: ~/.local/bin/uvx
  join(homedir(), ".cargo", "bin"),   // Rust-based installs
  "/opt/homebrew/bin",                // macOS Homebrew (Apple Silicon)
  "/usr/local/bin",
].join(":");

/**
 * Build a PATH string that includes both the current process PATH and the
 * extra directories above, so child processes can find uvx/uv even when
 * Node.js was launched with a minimal environment.
 */
function buildChildPath(): string {
  const current = process.env.PATH ?? "";
  // Prepend extra dirs so they take priority over system defaults.
  return `${EXTRA_PATH_DIRS}:${current}`;
}

/**
 * Resolve the full absolute path of a binary using the shell.
 * Returns null if the binary is not found, along with an install hint.
 */
async function resolveCommand(command: string): Promise<{ path: string } | { error: string }> {
  const childPath = buildChildPath();
  try {
    const { stdout } = await execAsync(`which ${command}`, {
      env: { ...process.env, PATH: childPath },
      timeout: 5_000,
    });
    const resolved = stdout.trim();
    if (resolved) return { path: resolved };
    return { error: `"${command}" not found in PATH` };
  } catch {
    // Build a helpful message depending on which binary is missing.
    if (command === "uvx" || command === "uv") {
      return {
        error:
          `"uvx" not found. Install uv (the Python package manager that provides uvx):\n` +
          `  curl -LsSf https://astral.sh/uv/install.sh | sh\n` +
          `Then open a new terminal or run: source ~/.local/bin/env`,
      };
    }
    return { error: `"${command}" not found — make sure it is installed and on your PATH` };
  }
}

const log = createLogger({ component: "aws-mcp" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AwsMcpTool {
  name: string;
  description: string;
  /** Flattened top-level parameter names from the tool's JSON Schema. */
  params: string[];
}

interface McpTextContent { type: "text"; text: string; }
interface McpToolResult  { content: Array<McpTextContent | { type: string }>; isError?: boolean; }

/** A connected MCP server slot. */
interface ServerSlot {
  serverName: string;
  client: Client;
  tools: AwsMcpTool[];
}

// ─── Well-known server defaults ───────────────────────────────────────────────

const KNOWN_SERVERS: Record<string, { command: string; description: string }> = {
  cloudwatch: {
    command: "uvx awslabs.cloudwatch-mcp-server@latest",
    description: "CloudWatch metrics, logs Insights, alarms — core SRE observability",
  },
  cloudtrail: {
    command: "uvx awslabs.cloudtrail-mcp-server@latest",
    description: "API audit trail — find recent deployments and config changes",
  },
  ecs: {
    command: "uvx --from awslabs-ecs-mcp-server ecs-mcp-server",
    description: "ECS service/task describe, container health",
  },
  eks: {
    command: "uvx awslabs.eks-mcp-server@latest",
    description: "EKS / Kubernetes cluster management",
  },
  iac: {
    command: "uvx awslabs.aws-iac-mcp-server@latest",
    description: "CloudFormation validation and deployment failure analysis",
  },
  iam: {
    command: "uvx awslabs.iam-mcp-server@latest",
    description: "IAM role/policy inspection and permission simulation",
  },
};

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Multi-server AWS MCP client.
 *
 * Connects to all configured awslabs MCP servers, merges their tool catalogs,
 * and routes callTool() to whichever server advertises the requested tool.
 */
export class AwsMcpService {
  private slots: ServerSlot[] = [];
  private toolIndex: Map<string, ServerSlot> = new Map(); // tool name → server
  private missingBinaries: Map<string, string> = new Map(); // server name → error msg
  private attempted = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Connect to all configured MCP servers. Safe to call multiple times.
   * Returns true if at least one server connected successfully.
   */
  async connect(): Promise<boolean> {
    if (this.attempted) return this.slots.length > 0;
    this.attempted = true;

    const serverNames = parseServerList();

    if (serverNames.length > 0) {
      // Named multi-server mode: AWS_MCP_SERVERS=cloudwatch,cloudtrail,...
      await Promise.all(serverNames.map((name) => this.connectNamedServer(name)));
    } else {
      // Backward-compatible single-server mode.
      await this.connectLegacySingleServer();
    }

    this.buildToolIndex();

    if (this.slots.length > 0) {
      log.info("AWS MCP ready", {
        event: "aws_mcp_ready",
        servers: this.slots.map((s) => s.serverName),
        totalTools: this.toolIndex.size,
      });
    }

    return this.slots.length > 0;
  }

  async disconnect(): Promise<void> {
    await Promise.all(
      this.slots.map((s) => s.client.close().catch(() => {})),
    );
    this.slots = [];
    this.toolIndex.clear();
    this.missingBinaries.clear();
    this.attempted = false;
  }

  isConnected(): boolean {
    return this.slots.length > 0;
  }

  /**
   * All tools advertised by every connected server, merged.
   * Returned in server order — tools from earlier servers come first.
   */
  getDiscoveredTools(): AwsMcpTool[] {
    return this.slots.flatMap((s) => s.tools);
  }

  /**
   * Names of all successfully connected servers (for display).
   */
  getConnectedServers(): string[] {
    return this.slots.map((s) => s.serverName);
  }

  // ── Tool calling ─────────────────────────────────────────────────────────────

  /**
   * Call a tool on whichever server advertises it.
   * Never throws — errors are returned as "ERROR: ..." strings.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isConnected()) {
      return buildNotConnectedError();
    }

    const slot = this.toolIndex.get(name);
    if (!slot) {
      // Check if the tool belonged to a server that failed to start.
      for (const [server, errMsg] of this.missingBinaries) {
        if (errMsg.includes(name) || name.startsWith(server)) {
          return `ERROR: MCP server "${server}" did not start — ${errMsg}`;
        }
      }
      const available = [...this.toolIndex.keys()].join(", ") || "(none)";
      return `ERROR: tool "${name}" not found in any connected MCP server. Available: ${available}`;
    }

    try {
      const result = (await slot.client.callTool({ name, arguments: args })) as McpToolResult;
      const text = result.content
        .filter((c): c is McpTextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (result.isError) {
        return `ERROR from ${name} (${slot.serverName}): ${text || "(no error detail)"}`;
      }
      return text || "(no output)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("MCP tool call failed", { event: "aws_mcp_tool_error", name, server: slot.serverName, err: msg });
      return `ERROR calling ${name} on ${slot.serverName}: ${msg}`;
    }
  }

  // ── Private: connection helpers ───────────────────────────────────────────────

  /** Connect a named server from AWS_MCP_SERVERS (e.g. "cloudwatch"). */
  private async connectNamedServer(serverName: string): Promise<void> {
    const ucName = serverName.toUpperCase();

    // Per-server URL takes priority over command.
    const url = process.env[`AWS_MCP_${ucName}_URL`]?.trim();
    if (url) {
      await this.connectHttp(serverName, url);
      return;
    }

    // Per-server command, fallback to well-known default.
    const rawCmd =
      process.env[`AWS_MCP_${ucName}_COMMAND`]?.trim() ||
      KNOWN_SERVERS[serverName.toLowerCase()]?.command;

    if (!rawCmd) {
      log.warn(`No command or URL for MCP server "${serverName}" — skipping.`, {
        hint: `Set AWS_MCP_${ucName}_COMMAND or AWS_MCP_${ucName}_URL`,
      });
      return;
    }

    await this.connectStdio(serverName, rawCmd);
  }

  /** Backward-compatible single-server (AWS_MCP_URL / AWS_MCP_TRANSPORT). */
  private async connectLegacySingleServer(): Promise<void> {
    const url       = process.env.AWS_MCP_URL?.trim();
    const transport = process.env.AWS_MCP_TRANSPORT?.trim().toLowerCase();

    if (url) {
      await this.connectHttp("default", url);
    } else if (transport === "stdio") {
      const cmd = process.env.AWS_MCP_COMMAND?.trim() || "uvx awslabs.aws-mcp-server@latest";
      await this.connectStdio("default", cmd);
    }
    // else: not configured — stay silent.
  }

  private async connectHttp(serverName: string, url: string): Promise<void> {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const client    = new Client({ name: "infra-copilot", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      const tools = await discoverTools(client, serverName);
      this.slots.push({ serverName, client, tools });
      log.info(`AWS MCP "${serverName}" connected via HTTP`, { event: "aws_mcp_connected", url, toolCount: tools.length });
    } catch (err) {
      log.debug(`AWS MCP "${serverName}" HTTP connect failed`, { url, err: String(err) });
    }
  }

  private async connectStdio(serverName: string, rawCmd: string): Promise<void> {
    const [command, ...args] = rawCmd.split(/\s+/);

    // Resolve the full path of the binary using the shell's PATH.
    // This handles the common case where uvx is in ~/.local/bin but the
    // Node.js process was started with a minimal PATH that omits it.
    const resolved = await resolveCommand(command);
    if ("error" in resolved) {
      log.warn(`AWS MCP "${serverName}" skipped — ${resolved.error}`, {
        event: "aws_mcp_binary_not_found",
        server: serverName,
        command,
      });
      // Store the error so it can be surfaced if the user calls mcp_tool.
      this.missingBinaries.set(serverName, resolved.error);
      return;
    }

    // Build env: pass full shell PATH + AWS credentials to the child process.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: buildChildPath(),
      FASTMCP_LOG_LEVEL: process.env.FASTMCP_LOG_LEVEL ?? "ERROR",
    };

    try {
      const transport = new StdioClientTransport({ command: resolved.path, args, env });
      const client    = new Client({ name: "infra-copilot", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      const tools = await discoverTools(client, serverName);
      this.slots.push({ serverName, client, tools });
      log.info(`AWS MCP "${serverName}" connected via stdio`, {
        event: "aws_mcp_connected", command: resolved.path, toolCount: tools.length,
      });
    } catch (err) {
      log.debug(`AWS MCP "${serverName}" stdio connect failed`, { command: resolved.path, err: String(err) });
    }
  }

  // ── Private: tool index ───────────────────────────────────────────────────────

  /** Build name → slot index across all connected servers. */
  private buildToolIndex(): void {
    this.toolIndex.clear();
    for (const slot of this.slots) {
      for (const tool of slot.tools) {
        if (!this.toolIndex.has(tool.name)) {
          this.toolIndex.set(tool.name, slot);
        } else {
          // Collision: prefix duplicate with server name.
          this.toolIndex.set(`${slot.serverName}:${tool.name}`, slot);
        }
      }
    }
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/** Parse AWS_MCP_SERVERS="cloudwatch,cloudtrail" → ["cloudwatch", "cloudtrail"] */
function parseServerList(): string[] {
  const raw = process.env.AWS_MCP_SERVERS?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Call listTools() on a connected client and map to our AwsMcpTool shape. */
async function discoverTools(client: Client, serverName: string): Promise<AwsMcpTool[]> {
  try {
    const result = await client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      params: extractParamNames(t.inputSchema as Record<string, unknown> | undefined),
    }));
  } catch (err) {
    log.warn(`Failed to list tools for "${serverName}"`, { err: String(err) });
    return [];
  }
}

/** Extract top-level property names from a JSON Schema object. */
function extractParamNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.["properties"] as Record<string, unknown> | undefined;
  return props ? Object.keys(props) : [];
}

function buildNotConnectedError(): string {
  const serverList = Object.keys(KNOWN_SERVERS).join(", ");
  return (
    `ERROR: AWS MCP server not connected.\n` +
    `Quick start — add to your environment:\n` +
    `  AWS_MCP_SERVERS=cloudwatch,cloudtrail   (well-known: ${serverList})\n` +
    `  AWS_PROFILE=<your-aws-profile>\n` +
    `  AWS_REGION=<region>\n\n` +
    `Or single server:\n` +
    `  AWS_MCP_URL=http://localhost:8091/mcp\n` +
    `  AWS_MCP_TRANSPORT=stdio  AWS_MCP_COMMAND="uvx awslabs.cloudwatch-mcp-server@latest"`
  );
}
