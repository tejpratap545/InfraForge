import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InfraPlan } from "../types";
import { createLogger } from "../utils/logging";

const exec = promisify(execCb);

// Timeouts: init can be slow on first run (plugin downloads); apply can take several minutes.
const INIT_TIMEOUT_MS  = 3  * 60 * 1000;  // 3 minutes
const PLAN_TIMEOUT_MS  = 3  * 60 * 1000;  // 3 minutes
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes
const log = createLogger({ component: "terraform-mcp" });

interface McpTextContent { type: "text"; text: string; }
interface McpToolResult  { content: Array<McpTextContent | { type: string }>; isError?: boolean; }

/**
 * Unified Terraform MCP service.
 *
 * Responsibilities:
 *  1. Read existing .tf files from a directory (SRE update flow).
 *  2. Materialize generated plan files into the tenant plan directory.
 *  3. Run terraform init / plan / apply — via MCP tools when the server
 *     exposes them (terraform_init, terraform_plan, terraform_apply),
 *     with a transparent exec() fallback otherwise.
 *
 * MCP server transport selection (same env-var convention as TerraformRegistryClient):
 *   TERRAFORM_MCP_URL=http://localhost:8080/mcp  → streamable-http
 *   TERRAFORM_MCP_TRANSPORT=stdio                → stdio binary
 *   (neither)                                    → try stdio, then HTTP fallback
 */
export class TerraformMcpService {
  private client: Client | null = null;
  private mcpConnected = false;

  constructor(private readonly workingRoot: string) {}

  // ── MCP lifecycle ────────────────────────────────────────────────────────────

  /** Connect to the MCP server if available. Safe to call multiple times. */
  async connect(): Promise<boolean> {
    if (this.mcpConnected) return true;

    const envUrl       = process.env.TERRAFORM_MCP_URL?.trim();
    const envTransport = process.env.TERRAFORM_MCP_TRANSPORT?.trim().toLowerCase();

    if (envUrl)                     return this.connectHttp(envUrl);
    if (envTransport === "stdio")   return this.connectStdio();

    // Auto-detect: try stdio binary first, then Docker HTTP.
    if (await this.connectStdio()) return true;
    return this.connectHttp("http://localhost:8080/mcp");
  }

  async disconnect(): Promise<void> {
    if (!this.mcpConnected || !this.client) return;
    try { await this.client.close(); } finally {
      this.client = null;
      this.mcpConnected = false;
    }
  }

  // ── File I/O ─────────────────────────────────────────────────────────────────

  /**
   * Read all .tf and .tfvars files from an existing Terraform directory.
   * Used by the SRE update flow where the caller already has a tf directory.
   */
  async readExistingFiles(dir: string): Promise<Record<string, string>> {
    const entries = await readdir(dir);
    const tfFiles = entries.filter((f) => f.endsWith(".tf") || f.endsWith(".tfvars"));
    if (tfFiles.length === 0) {
      throw new Error(`No .tf files found in ${dir}`);
    }
    const pairs = await Promise.all(
      tfFiles.map(async (name) => [name, await readFile(join(dir, name), "utf-8")] as const),
    );
    return Object.fromEntries(pairs);
  }

  /**
   * Write (overwrite) a set of files into an existing directory.
   * Used after LLM patches existing files.
   */
  async writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content, "utf-8")),
    );
  }

  private tenantPlanDir(tenantId: string, planId: string): string {
    return join(this.workingRoot, "tenants", tenantId, "plans", planId);
  }

  /** Write generated plan files into a fresh tenant plan directory. */
  async materializePlan(tenantId: string, plan: InfraPlan): Promise<string> {
    const startedAt = Date.now();
    const dir = this.tenantPlanDir(tenantId, plan.planId);
    await mkdir(dir, { recursive: true });

    const files = Object.entries(plan.terraform.files);
    await Promise.all(files.map(([name, content]) => writeFile(join(dir, name), content, "utf-8")));
    log.debug("Materialized terraform plan", {
      event: "materialize_plan",
      tenantId,
      planId: plan.planId,
      fileCount: files.length,
      dir,
      latencyMs: Date.now() - startedAt,
    });
    return dir;
  }

  // ── Terraform operations ─────────────────────────────────────────────────────

  async runPlan(terraformDir: string): Promise<string> {
    const startedAt = Date.now();

    // init
    const initOut = await this.callMcpTool("terraform_init", { workingDir: terraformDir });
    if (initOut === null) {
      try {
        await exec(`terraform -chdir="${terraformDir}" init -input=false`, { timeout: INIT_TIMEOUT_MS });
      } catch (err) {
        throw new Error(`terraform init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // plan
    const mcpPlan = await this.callMcpTool("terraform_plan", { workingDir: terraformDir });
    if (mcpPlan !== null) {
      log.debug("Terraform plan via MCP", { event: "terraform_plan_mcp", terraformDir, latencyMs: Date.now() - startedAt });
      return mcpPlan;
    }

    try {
      const result = await exec(
        `terraform -chdir="${terraformDir}" plan -input=false -no-color`,
        { timeout: PLAN_TIMEOUT_MS },
      );
      if (result.stderr) {
        log.warn("Terraform plan stderr", { event: "terraform_plan_stderr", terraformDir, stderr: result.stderr.slice(0, 500) });
      }
      log.debug("Terraform plan via exec", { event: "terraform_plan_exec", terraformDir, latencyMs: Date.now() - startedAt });
      return result.stdout;
    } catch (err) {
      throw new Error(`terraform plan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runApply(terraformDir: string): Promise<string> {
    const startedAt = Date.now();

    const mcpApply = await this.callMcpTool("terraform_apply", { workingDir: terraformDir, autoApprove: true });
    if (mcpApply !== null) {
      log.debug("Terraform apply via MCP", { event: "terraform_apply_mcp", terraformDir, latencyMs: Date.now() - startedAt });
      return mcpApply;
    }

    try {
      const result = await exec(
        `terraform -chdir="${terraformDir}" apply -auto-approve -input=false -no-color`,
        { timeout: APPLY_TIMEOUT_MS },
      );
      if (result.stderr) {
        log.warn("Terraform apply stderr", { event: "terraform_apply_stderr", terraformDir, stderr: result.stderr.slice(0, 500) });
      }
      log.debug("Terraform apply via exec", { event: "terraform_apply_exec", terraformDir, latencyMs: Date.now() - startedAt });
      return result.stdout;
    } catch (err) {
      throw new Error(`terraform apply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Call a tool on the MCP server. Returns the text output, or null if the
   * server is unavailable or doesn't expose the tool (triggers exec fallback).
   */
  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<string | null> {
    if (!this.client) return null;
    try {
      const result = (await this.client.callTool({ name, arguments: args })) as McpToolResult;
      if (result.isError) return null;
      return result.content
        .filter((c): c is McpTextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim() || null;
    } catch {
      return null;
    }
  }

  private async connectHttp(url: string): Promise<boolean> {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      this.client = new Client({ name: "infra-copilot", version: "1.0.0" }, { capabilities: {} });
      await this.client.connect(transport);
      this.mcpConnected = true;
      return true;
    } catch {
      this.client = null;
      return false;
    }
  }

  private async connectStdio(): Promise<boolean> {
    try {
      const transport = new StdioClientTransport({ command: "terraform-mcp-server", args: ["stdio"] });
      this.client = new Client({ name: "infra-copilot", version: "1.0.0" }, { capabilities: {} });
      await this.client.connect(transport);
      this.mcpConnected = true;
      return true;
    } catch {
      this.client = null;
      return false;
    }
  }
}
