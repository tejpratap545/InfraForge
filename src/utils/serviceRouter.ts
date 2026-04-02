/**
 * serviceRouter.ts
 *
 * Detects which AWS service groups are relevant from the user's question.
 * No LLM needed — fast keyword matching.
 *
 * Result drives:
 *   1. Which MCP servers to connect (elasticache vs ecs vs rds etc.)
 *   2. Which service-specific reference block to inject into the LLM prompt
 */

export type ServiceGroup =
  | "elasticache"
  | "ecs"
  | "eks_k8s"
  | "rds"
  | "alb"
  | "ec2_asg"
  | "lambda"
  | "messaging"
  | "networking"
  | "cloudtrail"
  | "general";

interface ServiceRule {
  group: ServiceGroup;
  /** MCP server names to prioritise for this group */
  mcpServers: string[];
  keywords: RegExp;
}

const RULES: ServiceRule[] = [
  {
    group: "elasticache",
    mcpServers: ["elasticache"],
    keywords: /redis|elasticache|valkey|memcached|cache.?hit|cache.?miss|eviction|replication.?group|cache.?cluster/i,
  },
  {
    group: "ecs",
    mcpServers: ["ecs", "cloudwatch"],
    keywords: /\becs\b|elastic.?container|fargate|task.?def|container.?service|ecs.?service|ecs.?cluster/i,
  },
  {
    group: "eks_k8s",
    mcpServers: ["eks"],
    keywords: /\beks\b|kubernetes|kubectl|\bk8s\b|pod|deployment|namespace|node.?group|cluster.?node|helm|daemonset|statefulset|crashloop|oomkill/i,
  },
  {
    group: "rds",
    mcpServers: ["postgres", "mysql"],
    keywords: /\brds\b|aurora|postgres|mysql|database.?connection|db.?cpu|db.?load|slow.?quer|replication.?lag|iops|db.?instance/i,
  },
  {
    group: "alb",
    mcpServers: ["cloudwatch"],
    keywords: /\balb\b|\bnlb\b|load.?balancer|target.?group|5xx|4xx|request.?count|response.?time|listener|health.?check/i,
  },
  {
    group: "ec2_asg",
    mcpServers: ["cloudwatch"],
    keywords: /\bec2\b|auto.?scal|instance.?(cpu|memory|disk)|launch.?template|scaling.?activit|spot.?instance/i,
  },
  {
    group: "lambda",
    mcpServers: ["lambda", "cloudwatch"],
    keywords: /\blambda\b|function.?(error|timeout|throttl|duration|cold.?start)|serverless/i,
  },
  {
    group: "messaging",
    mcpServers: ["sns", "msk"],
    keywords: /\bsqs\b|\bsns\b|\bmsk\b|kafka|queue.?(depth|lag|delay)|dead.?letter|message.?(count|age)|consumer.?lag/i,
  },
  {
    group: "networking",
    mcpServers: ["network"],
    keywords: /\bvpc\b|subnet|security.?group|route.?table|transit.?gateway|nat.?gateway|\bdns\b|route.?53|hosted.?zone/i,
  },
  {
    group: "cloudtrail",
    mcpServers: ["cloudtrail"],
    keywords: /cloudtrail|who.?(creat|delet|modif|changed)|what.?changed|deploy|config.?change|api.?call|iam.?event/i,
  },
];

export interface RoutingResult {
  groups: ServiceGroup[];
  mcpServers: string[];
}

export function routeQuestion(question: string): RoutingResult {
  const matched = RULES.filter((r) => r.keywords.test(question));

  // Always include cloudwatch as it underpins all metrics
  const groups: ServiceGroup[] = matched.length > 0
    ? matched.map((r) => r.group)
    : ["general"];

  const mcpServers = [...new Set(matched.flatMap((r) => r.mcpServers))];

  return { groups, mcpServers };
}
