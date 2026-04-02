import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BedrockService } from "../services/bedrockService";
import { ProviderSchema } from "../services/terraformRegistryClient";
import { InfraPlan, Intent, PlanStep } from "../types";
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
      "Your task is to update the files to fulfil the instruction — change only what is necessary.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No extra text.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        summary: "One-sentence description of what changed",
        steps: [
          {
            description: "Human-readable step description",
            target: "terraform resource address e.g. aws_rds_cluster.replica",
            risk: '"low" | "medium" | "high"',
          },
        ],
        terraform: {
          files: {
            "rds_replica.tf": "ONLY files that were added or modified — omit unchanged files entirely",
          },
        },
      }, null, 2),
      "",
      "RULES:",
      "1. ONLY include files in terraform.files that you actually added or changed. Omit unchanged files — they will be merged automatically.",
      "2. Never remove existing resources unless the instruction explicitly asks for deletion.",
      "3. Preserve all existing tags, variable names, and provider configuration.",
      "4. NEVER use empty string (\"\") or empty list ([]) for required resource attributes.",
      "5. Follow the same naming conventions already present in the files.",
      "6. Prefer creating a new file (e.g. rds_replica.tf) over modifying a large existing file when adding new resources.",
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
   * Generate a Terraform plan from the user's intent.
   *
   * @param intent   Parsed and clarified user intent.
   * @param schemas  Optional provider schemas fetched from the Terraform registry
   *                 via TerraformRegistryClient. When provided, the Argument
   *                 Reference section for each resource is injected into the
   *                 prompt as an authoritative source — this eliminates an
   *                 entire class of hallucinated required-field bugs (e.g.
   *                 cidr_block = "" or subnet_ids = []).
   */
  async generatePlan(intent: Intent, schemas: ProviderSchema[] = []): Promise<InfraPlan> {
    const schemaSection = this.buildSchemaSection(schemas);

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
      '2. Always include: provider "aws" { region = var.aws_region } and variable "aws_region" { default = "<region from intent>" }',
      "3. NEVER use empty string (\"\") or empty list ([]) for required resource attributes — omit optional fields instead.",
      "4. Use descriptive, lowercase resource names separated by underscores (e.g., aws_vpc.main, aws_eks_cluster.primary).",
      '5. Tag every resource: tags = { Name = "<logical-name>", ManagedBy = "infra-copilot", Environment = "dev" }',
      "6. For VPCs: include at least 2 subnets in different AZs (use data \"aws_availability_zones\" \"available\") for HA.",
      "7. For EKS clusters: include aws_eks_cluster + aws_eks_node_group + IAM roles with these policies:",
      "   - Cluster role: AmazonEKSClusterPolicy",
      "   - Node role: AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly",
      "8. For RDS: include aws_db_subnet_group + aws_security_group; set skip_final_snapshot=true, deletion_protection=false.",
      "9. For Lambda: include aws_iam_role with basic execution policy + aws_cloudwatch_log_group with retention_in_days=7.",
      "10. For delete actions: generate the resource config with a comment '# Run: terraform destroy' — do NOT generate empty files.",
      "11. Use data sources (data \"aws_availability_zones\", data \"aws_ami\") instead of hardcoding AZ names or AMI IDs.",
      "",
      "RISK ASSESSMENT RULES:",
      "- high: any deletion, IAM role/policy creation, public-facing resources (0.0.0.0/0 ingress), removing security groups",
      "- medium: stateful resources (RDS, EBS volumes, ElastiCache), VPC changes, EKS node group changes",
      "- low: S3 bucket creation, CloudWatch alarms, adding tags, read-only IAM policies, Lambda updates",
      schemaSection,
      "INTENT JSON:",
      JSON.stringify(intent, null, 2),
    ].join("\n");

    const raw = await this.bedrock.complete(prompt, { maxTokens: 4096 });
    const normalized = PlannerOutputSchema.parse(parseJsonPayload(raw, "Planner LLM (generate)"));
    return {
      planId: randomUUID(),
      action: intent.action,
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
