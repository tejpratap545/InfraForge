import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * A single provider resource schema extracted from the Terraform registry.
 * `content` holds the Argument Reference section — the authoritative list of
 * required and optional attributes for the resource.
 */
export interface ProviderSchema {
  resourceType: string;
  content: string;
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpToolResult {
  content: Array<McpTextContent | { type: string }>;
  isError?: boolean;
}

/**
 * Transport mode auto-detection:
 *
 *   TERRAFORM_MCP_URL=http://localhost:8080/mcp  → streamable-http (Docker)
 *   TERRAFORM_MCP_TRANSPORT=stdio                → stdio binary
 *   (neither set)                                → try stdio first, fall back to HTTP
 *
 * The Docker image runs in streamable-http mode:
 *   docker run -p 8080:8080 -e TRANSPORT_MODE=streamable-http terraform-mcp-server:dev
 * Set TERRAFORM_MCP_URL=http://localhost:8080/mcp in your environment before running infra commands.
 */
const DEFAULT_HTTP_URL = "http://localhost:8080/mcp";

type TransportMode = "http" | "stdio";

function resolveTransportMode(): { mode: TransportMode; url: string | null } {
  const envUrl = process.env.TERRAFORM_MCP_URL?.trim();
  const envTransport = process.env.TERRAFORM_MCP_TRANSPORT?.trim().toLowerCase();

  if (envUrl) return { mode: "http", url: envUrl };
  if (envTransport === "stdio") return { mode: "stdio", url: null };
  // No explicit config — will try stdio first, then HTTP fallback.
  return { mode: "stdio", url: null };
}

/**
 * MCP client for the HashiCorp Terraform registry server.
 *
 * Supports two transport modes depending on how the server is deployed:
 *
 *   • Streamable HTTP  — server running in Docker or as a remote process
 *     docker run -p 8080:8080 -e TRANSPORT_MODE=streamable-http terraform-mcp-server:dev
 *     export TERRAFORM_MCP_URL=http://localhost:8080/mcp
 *
 *   • Stdio            — server running as a local binary subprocess
 *     go install github.com/hashicorp/terraform-mcp-server/cmd/terraform-mcp-server@latest
 *     (no env var needed)
 *
 * Transport is selected by env var (see resolveTransportMode).
 * If neither transport is available, connect() returns false and all calls
 * are no-ops — the tool degrades gracefully rather than crashing.
 */
export class TerraformRegistryClient {
  private client: Client | null = null;
  private connected = false;
  private activeMode: TransportMode | null = null;

  /**
   * Establish the MCP connection using the configured transport.
   *
   * Resolution order:
   *   1. TERRAFORM_MCP_URL set  → HTTP to that URL (no fallback)
   *   2. TERRAFORM_MCP_TRANSPORT=stdio → stdio only (no fallback)
   *   3. Neither set → try stdio binary, then fall back to HTTP at localhost:8080
   *
   * Returns true if connected, false if unavailable.
   * Safe to call multiple times — no-op if already connected.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    const { mode, url } = resolveTransportMode();
    const explicitConfig = !!(process.env.TERRAFORM_MCP_URL || process.env.TERRAFORM_MCP_TRANSPORT);

    if (mode === "http" && url) {
      return this.connectHttp(url);
    }

    // Try stdio first.
    const stdioOk = await this.connectStdio();
    if (stdioOk) return true;

    // If no explicit config, auto-fall back to HTTP at the default Docker address.
    if (!explicitConfig) {
      return this.connectHttp(DEFAULT_HTTP_URL);
    }

    return false;
  }

  /**
   * Close the connection. Safe to call even if never connected.
   */
  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.connected = false;
      this.activeMode = null;
    }
  }

  /** Which transport is currently active (for logging). */
  get transport(): TransportMode | null {
    return this.activeMode;
  }

  /**
   * Fetch and trim the provider schema for a single resource type.
   * Returns null on any error (unknown resource, network failure, parse error).
   *
   * Only the "Argument Reference" section is returned — required/optional
   * attributes for code generation. Imports, timeouts, and attribute reference
   * sections are stripped to save tokens.
   */
  async fetchSchema(
    providerSlug: string,
    resourceType: string,
  ): Promise<ProviderSchema | null> {
    if (!this.client) return null;
    try {
      const result = (await this.client.callTool({
        name: "resolveProviderDocPage",
        arguments: { serviceSlug: providerSlug, resourceType },
    })) as McpToolResult;

      if (result.isError) return null;

      const raw = result.content
        .filter((c): c is McpTextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!raw) return null;

      return { resourceType, content: this.extractArgumentReference(raw) };
    } catch {
      return null;
    }
  }

  /**
   * Fetch schemas for multiple resource types in parallel.
   * Failed lookups are silently dropped — partial results are always returned.
   * Only `aws_*` resource types are queried.
   */
  async fetchSchemas(
    providerSlug: string,
    resourceTypes: string[],
  ): Promise<ProviderSchema[]> {
    if (!this.connected) return [];
    const unique = [...new Set(resourceTypes.filter((r) => r.startsWith("aws_")))];
    const results = await Promise.all(unique.map((rt) => this.fetchSchema(providerSlug, rt)));
    return results.filter((r): r is ProviderSchema => r !== null);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async connectHttp(url: string): Promise<boolean> {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      this.client = new Client(
        { name: "infra-copilot", version: "1.0.0" },
        { capabilities: {} },
      );
      await this.client.connect(transport);
      this.connected = true;
      this.activeMode = "http";
      return true;
    } catch {
      this.client = null;
      this.connected = false;
      return false;
    }
  }

  private async connectStdio(): Promise<boolean> {
    try {
      const transport = new StdioClientTransport({
        command: "terraform-mcp-server",
        args: ["stdio"],
      });
      this.client = new Client(
        { name: "infra-copilot", version: "1.0.0" },
        { capabilities: {} },
      );
      await this.client.connect(transport);
      this.connected = true;
      this.activeMode = "stdio";
      return true;
    } catch {
      this.client = null;
      this.connected = false;
      return false;
    }
  }

  /**
   * Extract the "Argument Reference" section from full provider doc markdown.
   *
   * Provider docs structure:
   *   ## Argument Reference
   *   * `required_field` - (Required) ...
   *   * `optional_field` - (Optional) ...
   *   ## Attributes Reference   ← stop here
   *
   * Capped at 2500 chars per resource to stay within token budgets for plans
   * that involve many resources simultaneously.
   */
  private extractArgumentReference(content: string, maxChars = 2500): string {
    const match = content.match(
      /##\s+Arguments?\s+Reference\s*([\s\S]*?)(?=\n##\s|\n#\s|$)/i,
    );
    const relevant = match?.[1]?.trim() ?? content;
    return relevant.length > maxChars
      ? relevant.slice(0, maxChars) + "\n... (truncated — see full docs)"
      : relevant;
  }
}
