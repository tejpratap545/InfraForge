import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BedrockService } from "../services/bedrockService";
import { ProviderSchema } from "../services/terraformRegistryClient";
import { InfraAction, InfraPlan, Intent, PlanStep } from "../types";
import { parseJsonPayload } from "../utils/llm";

const PlannerOutputSchema = z.object({
  summary: z.string().min(5),
  steps: z.array(
    z.object({
      description: z.string().min(3),
      target: z.string().min(2),
      risk: z.enum(["low", "medium", "high"]),
    }),
  ),
  terraform: z.object({
    // Models sometimes emit optional files with empty content (e.g. variables.tf: "").
    // Accept here and sanitize before returning the plan.
    files: z.record(z.string(), z.string()),
  }),
});

export class PlannerAgent {
  constructor(private readonly bedrock: BedrockService) {}

  /**
   * Patch an existing Terraform directory based on a plain-language instruction.
   *
   * Instead of generating files from scratch, the LLM receives the current file
   * contents and returns the full updated set of files — only changing what the
   * instruction requires. All unchanged files are passed through as-is.
   *
   * @param existingFiles  Map of filename → content read from the tf directory.
   * @param instruction    Plain-language change description, e.g. "add a read replica".
   * @param schemas        Optional provider schemas for attribute validation.
   */
  async patchExisting(
    existingFiles: Record<string, string>,
    instruction: string,
    schemas: ProviderSchema[] = [],
  ): Promise<InfraPlan> {
    const schemaSection = this.buildSchemaSection(schemas);

    const existingSection = Object.entries(existingFiles)
      .map(([name, content]) => `### ${name}\n\`\`\`hcl\n${content}\n\`\`\``)
      .join("\n\n");

    const prompt = [
      "You are a senior Terraform engineer. You are given existing Terraform files and a change instruction.",
      "Your task is to edit existing files and/or create new files to fulfil the instruction — like a code editor, touch only what needs changing.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No extra text.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        summary: "One-sentence description of what changed",
        steps: [
          {
            description: "Human-readable step description",
            target: "terraform resource address e.g. aws_eks_node_group.workers",
            risk: '"low" | "medium" | "high"',
          },
        ],
        terraform: {
          files: {
            "existing_file.tf": "FULL updated content of an existing file you modified — must include ALL original content plus your changes",
            "<new_resource>.tf": "FULL content of a brand-new file you are creating — name it after the resource (e.g. node_pool.tf, ec2_worker.tf, s3_backup.tf)",
          },
        },
      }, null, 2),
      "",
      "FILE EDITING RULES (follow exactly — this is the most important section):",
      "1. READ each existing file carefully before deciding where to make changes.",
      "2. If the change fits naturally inside an existing file (e.g. adding a node group to cluster.tf, adding a variable to variables.tf) → EDIT that file and return its FULL updated content.",
      "3. If the change is a self-contained new resource with no clear home → CREATE a new file named after the resource.",
      "4. Never return a partial file. Every file in terraform.files must be complete, valid HCL.",
      "5. Omit files you did not touch — they are merged automatically.",
      "6. Never remove existing resources unless the instruction explicitly asks for deletion.",
      "7. Preserve all existing tags, variable names, locals, and provider configuration.",
      "8. NEVER use empty string (\"\") or empty list ([]) for required resource attributes.",
      "9. EVERY variable declaration MUST have a default value. We run `terraform plan` without -var flags or .tfvars, so any variable without a default causes a fatal error. Populate defaults from the instruction or existing file values. If unknown, use a data source lookup instead of a bare variable.",
      "10. Follow the naming conventions already present in the files.",
      schemaSection,
      "EXISTING FILES:",
      existingSection,
      "",
      "CHANGE INSTRUCTION:",
      instruction,
    ].join("\n");

    const raw = await this.bedrock.complete(prompt, { maxTokens: 8096 });
    const normalized = PlannerOutputSchema.parse(parseJsonPayload(raw, "Planner LLM (patch)"));
    // Merge: start with existing files, overlay only what the LLM changed/added.
    const mergedFiles = { ...existingFiles, ...this.filterFiles(normalized.terraform.files) };
    return {
      planId: randomUUID(),
      action: "update",
      summary: normalized.summary,
      terraform: { files: mergedFiles },
      steps: this.buildSteps(normalized.steps),
      requiresApproval: true,
    };
  }

  /**
   * Generate a Terraform plan from a fully-enriched description string.
   *
   * This is the agentic entry point — the description is produced by ClarifyAgent
   * after it has interactively gathered all required parameters from the user.
   * No Intent parsing or field extraction happens here; the LLM works purely from
   * the natural-language description.
   *
   * @param description  Enriched instruction, e.g.
   *                     "Create a t3.medium EC2 instance named web-server in ap-south-1".
   * @param schemas      Optional provider schemas for attribute validation.
   */
  async generatePlanFromDescription(description: string, schemas: ProviderSchema[] = []): Promise<InfraPlan> {
    const schemaSection = this.buildSchemaSection(schemas);

    // Detect action from description keywords so we can set plan.action correctly.
    const action: InfraAction =
      /\b(delete|remove|destroy|tear\s*down)\b/i.test(description) ? "delete" :
      /\b(update|modify|change|resize|patch|scale)\b/i.test(description) ? "update" :
      "create";

    const prompt = [
      "You are a senior Terraform engineer generating production-ready AWS infrastructure configurations.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No extra text.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        summary: "One-sentence description of what will be provisioned",
        steps: [
          {
            description: "Human-readable step description",
            target: "terraform resource address e.g. aws_vpc.main",
            risk: '"low" | "medium" | "high"',
          },
        ],
        terraform: {
          files: {
            "main.tf": "full HCL content",
            "variables.tf": "variable declarations (include if variables are used)",
            "outputs.tf": "output declarations (include if outputs are defined)",
          },
        },
      }, null, 2),
      "",
      "TERRAFORM REQUIREMENTS:",
      "1. Always start main.tf with a terraform block:",
      '   terraform { required_version = ">= 1.5"',
      '     required_providers { aws = { source = "hashicorp/aws" version = "~> 5.0" } } }',
      '2. Always include: provider "aws" { region = var.aws_region } and variable "aws_region" { default = "<region from description>" }',
      "3. EVERY variable declaration MUST have a default value populated from the description. We run `terraform plan` without -var flags or .tfvars, so any variable without a default will cause a fatal error. If the description mentions a cluster name, subnet IDs, VPC ID, etc., hardcode those values as defaults. If a value is unknown, prefer using a data source lookup or hardcoding a sensible default rather than leaving the variable without one.",
      "4. NEVER use empty string (\"\") or empty list ([]) for required resource attributes — omit optional fields instead.",
      "5. Use descriptive, lowercase resource names derived from the name in the description (e.g. aws_instance.web_server).",
      '6. Tag every resource: tags = { Name = "<logical-name>", ManagedBy = "infra-copilot", Environment = "dev" }',
      "7. For VPCs: include at least 2 subnets in different AZs (use data \"aws_availability_zones\" \"available\") for HA.",
      "8. For EKS clusters: include aws_eks_cluster + aws_eks_node_group + IAM roles with these policies:",
      "   - Cluster role: AmazonEKSClusterPolicy",
      "   - Node role: AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly",
      "9. For RDS: include aws_db_subnet_group + aws_security_group; set skip_final_snapshot=true, deletion_protection=false.",
      "10. For Lambda: include aws_iam_role with basic execution policy + aws_cloudwatch_log_group with retention_in_days=7.",
      "11. For delete actions: generate the resource config with a comment '# Run: terraform destroy' — do NOT generate empty files.",
      "12. Use data sources (data \"aws_availability_zones\", data \"aws_ami\") instead of hardcoding AZ names or AMI IDs.",
      "",
      "RISK ASSESSMENT RULES:",
      "- high: any deletion, IAM role/policy creation, public-facing resources (0.0.0.0/0 ingress), removing security groups",
      "- medium: stateful resources (RDS, EBS volumes, ElastiCache), VPC changes, EKS node group changes",
      "- low: S3 bucket creation, CloudWatch alarms, adding tags, read-only IAM policies, Lambda updates",
      schemaSection,
      "DESCRIPTION:",
      description,
    ].join("\n");

    const raw = await this.bedrock.complete(prompt, { maxTokens: 4096 });
    const normalized = PlannerOutputSchema.parse(parseJsonPayload(raw, "Planner LLM (generate)"));
    return {
      planId: randomUUID(),
      action,
      summary: normalized.summary,
      terraform: { files: this.filterFiles(normalized.terraform.files) },
      steps: this.buildSteps(normalized.steps),
      requiresApproval: true,
    };
  }
 
  private filterFiles(files: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(files).filter(([, content]) => content.trim().length > 0),
    );
  }

  private buildSteps(steps: Array<{ description: string; target: string; risk: "low" | "medium" | "high" }>): PlanStep[] {
    return steps.map((s) => ({ id: randomUUID(), description: s.description, target: s.target, risk: s.risk }));
  }

  /**
   * Build the schema injection section for the prompt.
   * Empty string when no schemas are available (server not installed).
   */
  private buildSchemaSection(schemas: ProviderSchema[]): string {
    if (schemas.length === 0) return "";
    return [
      "",
      "AUTHORITATIVE PROVIDER SCHEMAS (fetched live from the Terraform registry):",
      "These are the exact attribute definitions for each resource. Honour required vs optional.",
      "Do NOT use attributes not listed here. Do NOT leave required attributes empty.",
      ...schemas.map((s) => `\n### ${s.resourceType}\n${s.content}`),
      "",
    ].join("\n");
  }
}
