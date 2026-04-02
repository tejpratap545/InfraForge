import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BedrockService } from "../services/bedrockService";
import { AwsExecutionPlan, CloudControlCall, PlanStep } from "../types";
import { parseJsonPayload } from "../utils/llm";

const AwsPlannerOutputSchema = z.object({
  summary: z.string().min(5),
  steps: z.array(
    z.object({
      description: z.string().min(3),
      target: z.string().min(2),
      risk: z.enum(["low", "medium", "high"]),
    }),
  ),
  calls: z.array(
    z.object({
      typeName:     z.string(),
      operation:    z.enum(["create", "update", "delete"]),
      desiredState: z.record(z.string(), z.unknown()),
      identifier:   z.string().optional(),
      description:  z.string(),
    }),
  ),
});

/**
 * Generates an AWS Cloud Control execution plan from user intent.
 * Used when --engine aws is set — skips Terraform entirely.
 *
 * Cloud Control API accepts any CloudFormation resource type and a JSON
 * desiredState blob, so the LLM only needs to know CFN property names —
 * much simpler than knowing every SDK operation signature.
 */
export class AwsPlannerAgent {
  constructor(private readonly bedrock: BedrockService) {}

  async generatePlan(description: string, region = "us-east-1"): Promise<AwsExecutionPlan> {
    const prompt = [
      "You are a senior AWS engineer generating a Cloud Control API execution plan.",
      "Map the user's description to an ordered list of AWS Cloud Control operations.",
      "Cloud Control uses CloudFormation resource type names and property schemas.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No extra text.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        summary: "One-sentence description",
        steps: [{ description: "step", target: "AWS::RDS::DBInstance/my-db", risk: "low|medium|high" }],
        calls: [
          {
            typeName:     "CloudFormation resource type e.g. AWS::RDS::DBInstance",
            operation:    "create | update | delete",
            desiredState: { "...": "CFN property names (PascalCase) and values for this resource" },
            identifier:   "primary identifier — only for update/delete, omit for create",
            description:  "what this call does",
          },
        ],
      }, null, 2),
      "",
      "RULES:",
      "1. Order calls so dependencies come first (VPC → Subnet → SubnetGroup → DBInstance).",
      "2. Use exact CloudFormation property names (PascalCase). These are the same as CFN templates.",
      "3. Tag every resource: Tags: [{ Key: 'ManagedBy', Value: 'infra-copilot' }, { Key: 'Environment', Value: 'dev' }]",
      `4. Default region if not in description: ${region}`,
      "5. RISK: high=IAM/delete/public-access, medium=stateful(RDS/EBS/EKS), low=S3/CloudWatch/tags.",
      "6. For RDS: set SkipFinalSnapshotBeforeDeletion: true, DeletionProtection: false.",
      "7. For IAM roles: AssumeRolePolicyDocument must be a JSON object (not a string).",
      "",
      "COMMON TYPE → PROPERTY REFERENCE:",
      "AWS::RDS::DBInstance       — DBInstanceIdentifier, DBInstanceClass, Engine, EngineVersion, MasterUsername, MasterUserPassword, AllocatedStorage, DBSubnetGroupName, VPCSecurityGroups, MultiAZ, BackupRetentionPeriod",
      "AWS::RDS::DBSubnetGroup    — DBSubnetGroupName, DBSubnetGroupDescription, SubnetIds",
      "AWS::EC2::VPC              — CidrBlock, EnableDnsHostnames, EnableDnsSupport",
      "AWS::EC2::Subnet           — VpcId, CidrBlock, AvailabilityZone",
      "AWS::EC2::SecurityGroup    — GroupDescription, VpcId, SecurityGroupIngress",
      "AWS::S3::Bucket            — BucketName, VersioningConfiguration, BucketEncryption, PublicAccessBlockConfiguration",
      "AWS::IAM::Role             — RoleName, AssumeRolePolicyDocument, ManagedPolicyArns",
      "AWS::EKS::Cluster          — Name, Version, ResourcesVpcConfig, RoleArn",
      "AWS::Lambda::Function      — FunctionName, Runtime, Handler, Role, Code, Environment",
      "AWS::DynamoDB::Table       — TableName, BillingMode, AttributeDefinitions, KeySchema",
      "AWS::ElasticLoadBalancingV2::LoadBalancer — Name, Type, Subnets, SecurityGroups",
      "",
      "DESCRIPTION:",
      description,
    ].join("\n");

    const raw = await this.bedrock.complete(prompt, { maxTokens: 8096 });
    const normalized = AwsPlannerOutputSchema.parse(parseJsonPayload(raw, "AwsPlannerAgent"));
    const steps: PlanStep[] = normalized.steps.map((s) => ({
      id:          randomUUID(),
      description: s.description,
      target:      s.target,
      risk:        s.risk,
    }));
    const calls: CloudControlCall[] = normalized.calls.map((c) => ({
      typeName:     c.typeName,
      operation:    c.operation,
      desiredState: c.desiredState as Record<string, unknown>,
      identifier:   c.identifier,
      description:  c.description,
    }));

    return { planId: randomUUID(), summary: normalized.summary, steps, calls, requiresApproval: true };
  }
}
