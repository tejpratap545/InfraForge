import { z } from "zod";
import { BedrockService } from "../services/bedrockService";
import { ClarificationQuestion, Intent } from "../types";
import { extractJsonPayload, parseJsonPayload } from "../utils/llm";

const IntentSchema = z.object({
  action: z.enum(["create", "update", "delete", "debug"]),
  // Allow any AWS Terraform resource type, e.g. aws_lambda_function, aws_db_instance.
  resourceTypes: z.array(z.string().min(2)).default([]),
  // LLMs frequently emit null for missing optionals, so accept nullish here.
  region: z.string().nullish(),
  instanceType: z.string().nullish(),
  clusterName: z.string().nullish(),
  vpcCidr: z.string().nullish(),
  roleName: z.string().nullish(),
  bucketName: z.string().nullish(),
  parameters: z.record(z.string(), z.string()).default({}),
});

const ClarificationSchema = z.object({
  questions: z
    .array(
      z.object({
        key: z.string().min(1),
        question: z.string().min(3),
        required: z.boolean().default(true),
        options: z.array(z.string().min(1)).optional(),
        allowCustom: z.boolean().optional(),
      }),
    )
    .default([]),
});

export class IntentAgent {
  constructor(private readonly bedrock: BedrockService) {}

  async parse(rawInput: string): Promise<Intent> {
    const prompt = [
      "You are an AWS infrastructure intent parser. Extract structured parameters from natural language infrastructure requests.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No explanation. No extra text.",
      "",
      "JSON SCHEMA:",
      JSON.stringify({
        action: '"create" | "update" | "delete" | "debug"',
        resourceTypes: "string[]  // Terraform resource types e.g. [\"aws_eks_cluster\",\"aws_vpc\"]",
        region: "string | null  // e.g. \"us-east-1\"",
        instanceType: "string | null  // e.g. \"t3.medium\"",
        clusterName: "string | null",
        vpcCidr: "string | null  // e.g. \"10.0.0.0/16\"",
        roleName: "string | null",
        bucketName: "string | null",
        parameters: "{}  // additional key-value pairs not covered above",
      }, null, 2),
      "",
      "INFERENCE RULES:",
      "- Verbs: create/provision/deploy/launch → action:create | delete/remove/destroy/tear down → action:delete | update/modify/change/resize → action:update | debug/analyze/investigate/check → action:debug",
      "- EKS/Kubernetes cluster → [\"aws_eks_cluster\",\"aws_eks_node_group\",\"aws_vpc\",\"aws_subnet\",\"aws_iam_role\"]",
      "- S3 bucket/object storage → [\"aws_s3_bucket\"]",
      "- RDS/database/PostgreSQL/MySQL → [\"aws_db_instance\",\"aws_db_subnet_group\",\"aws_security_group\"]",
      "- Lambda/serverless function → [\"aws_lambda_function\",\"aws_iam_role\",\"aws_cloudwatch_log_group\"]",
      "- EC2 instance/virtual machine/VM → [\"aws_instance\",\"aws_security_group\",\"aws_key_pair\"]",
      "- VPC/network/virtual private cloud → [\"aws_vpc\",\"aws_subnet\",\"aws_internet_gateway\",\"aws_route_table\"]",
      "- ALB/load balancer/ELB → [\"aws_lb\",\"aws_lb_listener\",\"aws_lb_target_group\"]",
      "- CloudFront/CDN → [\"aws_cloudfront_distribution\"]",
      "- DynamoDB/NoSQL → [\"aws_dynamodb_table\"]",
      "- SQS/queue → [\"aws_sqs_queue\"]",
      "- SNS/topic → [\"aws_sns_topic\"]",
      "- ElastiCache/Redis/Memcached → [\"aws_elasticache_cluster\",\"aws_elasticache_subnet_group\"]",
      "- Regions: \"Virginia\"/\"N. Virginia\" → us-east-1 | \"Ohio\" → us-east-2 | \"Oregon\" → us-west-2 | \"Ireland\" → eu-west-1 | \"Frankfurt\" → eu-central-1 | \"Mumbai\" → ap-south-1 | \"Singapore\" → ap-southeast-1 | \"Tokyo\" → ap-northeast-1",
      "- Extract instance type verbatim if mentioned (e.g. t3.micro, m5.large, c6i.xlarge, r6g.2xlarge).",
      "- Extract CIDR blocks verbatim (e.g. 10.0.0.0/16).",
      "- If intent is ambiguous about action, default to action:create.",
      "",
      `USER INPUT: ${rawInput}`,
    ].join("\n");

    const response = await this.bedrock.complete(prompt);
    const parsed = parseJsonPayload(response, "Intent parser");
    const normalized = IntentSchema.parse(parsed);
    // LLMs often emit null for optional fields; convert to undefined for strict typing.
    const cleaned = Object.fromEntries(
      Object.entries(normalized).map(([key, value]) => [key, value === null ? undefined : value]),
    );
    return { ...(cleaned as Omit<Intent, "rawInput">), rawInput };
  }

  async suggestClarificationQuestions(intent: Intent): Promise<ClarificationQuestion[]> {
    const prompt = [
      "You are an AWS infrastructure requirements analyst. Identify missing or ambiguous parameters in an infrastructure intent before Terraform planning can begin.",
      "",
      "OUTPUT: Return ONLY a valid JSON object. No markdown. No explanation.",
      "",
      'JSON SCHEMA: {"questions":[{"key":"snake_case_key","question":"user-facing question","required":true,"options":["opt1","opt2"],"allowCustom":true}]}',
      "",
      "RULES:",
      "1. Only ask for parameters NECESSARY to generate a valid Terraform plan. Skip optional niceties (tags, encryption) unless critical.",
      "2. Always ask for region if missing. Provide standard AWS region options.",
      "3. For EKS: ask for Kubernetes version (options: 1.28, 1.29, 1.30), node instance type (allowCustom), and desired node count if not provided.",
      "4. For RDS: ask for engine (options: postgres, mysql, aurora-postgresql, aurora-mysql), instance class (options: db.t3.micro, db.t3.medium, db.r6g.large, allowCustom), and allocated storage if not provided.",
      "5. For EC2: ask for instance type (options: t3.micro, t3.medium, m5.large, c6i.xlarge, allowCustom) if not provided.",
      "6. For VPC: ask for CIDR block (options: 10.0.0.0/16, 172.16.0.0/16, 192.168.0.0/16, allowCustom) if vpcCidr missing.",
      "7. For S3: skip all questions unless intent implies specific behavior (versioning, website hosting, replication).",
      "8. Set allowCustom=true for instance types, engine versions, CIDR ranges, and any field with more than 6 valid values.",
      "9. Keep options to max 6 per question. Prefer most common values first.",
      "10. Max 6 questions total. Merge related questions if possible.",
      "",
      "PARSED INTENT:",
      JSON.stringify(intent, null, 2),
    ].join("\n");

    const response = await this.bedrock.complete(prompt);
    const payload = extractJsonPayload(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }
    const normalized = ClarificationSchema.safeParse(parsed);
    if (!normalized.success) return [];
    return normalized.data.questions;
  }
}
