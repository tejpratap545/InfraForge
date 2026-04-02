export type InfraAction = "create" | "update" | "delete" | "debug" | "patch";
/** Any CloudFormation resource type string or human alias, e.g. "AWS::EKS::Cluster" or "eks". */
export type AwsInventoryServiceName = string;

// Keep this open so intent parsing can support the full AWS Terraform provider surface.
export type InfraResourceType = string;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface TenantContext {
  tenantId: string;
  subscriptionTier: "free" | "pro" | "enterprise";
  userId: string;
  awsRegion: string;
  /** Explicit AWS credentials for this account. Falls back to SDK default chain if omitted. */
  awsCredentials?: AwsCredentials;
}

export interface Intent {
  action: InfraAction;
  resourceTypes: InfraResourceType[];
  region?: string;
  instanceType?: string;
  clusterName?: string;
  vpcCidr?: string;
  roleName?: string;
  bucketName?: string;
  parameters?: Record<string, string>;
  rawInput: string;
  /** Absolute path to an existing Terraform directory. Set by the `update` command. */
  terraformDir?: string;
}

export interface ClarificationQuestion {
  key: string;
  question: string;
  required: boolean;
  options?: string[];
  allowCustom?: boolean;
}

export interface PlanStep {
  id: string;
  description: string;
  target: string;
  risk: "low" | "medium" | "high";
}

export interface InfraPlan {
  planId: string;
  action: InfraAction;
  summary: string;
  terraform: {
    files: Record<string, string>;
  };
  steps: PlanStep[];
  requiresApproval: true;
}

export interface ApplyResult {
  planOutput: string;
  applyOutput: string;
}

// ── Direct AWS Cloud Control execution ───────────────────────────────────────

/** A single Cloud Control API operation. */
export interface CloudControlCall {
  /** CloudFormation resource type, e.g. "AWS::RDS::DBInstance". */
  typeName: string;
  /** CRUD operation. */
  operation: "create" | "update" | "delete";
  /** Resource properties as a plain object (serialised to JSON for the API). */
  desiredState: Record<string, unknown>;
  /** Primary identifier — required for update/delete. */
  identifier?: string;
  /** Human-readable description shown before execution. */
  description: string;
}

/** Execution plan produced by AwsPlannerAgent for the --engine aws path. */
export interface AwsExecutionPlan {
  planId: string;
  summary: string;
  steps: PlanStep[];
  calls: CloudControlCall[];
  requiresApproval: true;
}

export type DebugSource =
  | "cloudwatch-logs"
  | "cloudwatch-metrics"
  | "opensearch"
  | "loki"
  | "k8s-pod-logs"
  | "k8s-events";

export type DebugSeverity = "info" | "warn" | "error" | "critical";

export interface DebugSignal {
  source: DebugSource;
  severity?: DebugSeverity;
  timestamp?: string;
  resourceName?: string; // log group, pod name, index, etc.
  payload: string;
}

/** Options passed to the debug command and forwarded to every provider. */
export interface DebugOptions {
  /** Kubernetes namespace to search. Defaults to "default". */
  namespace?: string;
  /** How far back to look: "30m", "1h", "6h", "24h". Defaults to "1h". */
  since?: string;
  /** Max log lines to fetch per source. Defaults to 50. */
  tailLines?: number;
  /** Explicit CloudWatch log group names (overrides auto-discovery). */
  logGroups?: string[];
  /** Loki base URL, e.g. http://loki.monitoring:3100 */
  lokiUrl?: string;
  /** OpenSearch/Elasticsearch base URL, e.g. https://opensearch:9200 */
  openSearchUrl?: string;
  /** OpenSearch index pattern. Defaults to "*". */
  openSearchIndex?: string;
  /** OpenSearch basic-auth user (optional). */
  openSearchUser?: string;
  /** OpenSearch basic-auth password (optional). */
  openSearchPass?: string;
  /** kubectl context name (empty = current context). */
  k8sContext?: string;
  /** AWS region forwarded from TenantContext. */
  awsRegion?: string;
}

/** Extracted intent from a natural-language diagnose question. */
export interface DiagnoseIntent {
  /** The service / workload name as it appears in k8s or AWS. */
  serviceName: string;
  /** Short description of the problem class. */
  problem: string;
  /** How far back to look based on the problem type. */
  lookBack: "30m" | "1h" | "6h" | "24h";
  /** Urgency derived from the problem description. */
  urgency: "critical" | "high" | "medium" | "low";
}

export interface PodSummary {
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  restarts: number;
  /** Last known container state key: "running" | "terminated" | "waiting". */
  containerState?: string;
  /** Reason from the container state (e.g. "CrashLoopBackOff", "OOMKilled"). */
  reason?: string;
}

export interface K8sDiscovery {
  namespace: string;
  crashingPods: PodSummary[];
  pendingPods: PodSummary[];
  runningPods: PodSummary[];
}

/** Full discovery result — everything auto-detected before signal collection. */
export interface DiscoveryResult {
  /** One entry per k8s namespace that contained matching pods. */
  k8s: K8sDiscovery[];
  /** CloudWatch log group names that match the service. */
  cloudWatchLogGroups: string[];
  /** Loki URL from env or discovery. */
  lokiUrl?: string;
  /** OpenSearch URL from env or discovery. */
  openSearchUrl?: string;
  openSearchIndex?: string;
  openSearchUser?: string;
  openSearchPass?: string;
  /** Human-readable lines describing what was found — printed to stdout. */
  summaryLines: string[];
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  tenantId: string;
  command: string;
}

export interface AskK8sQuery {
  /** k8s resource types to fetch, e.g. ["pods", "namespaces", "deployments"] */
  resources: string[];
  /** Namespace to filter by; "all" or undefined = --all-namespaces */
  namespace?: string;
  /** Optional cluster name — used to run aws eks update-kubeconfig if needed */
  clusterName?: string;
}

export interface AskMetricsContext {
  /** AWS resource type to query metrics for: ec2 | eks | lambda | rds | ecs | alb */
  resourceType: string;
  /** Optional specific resource name/id to filter by */
  resourceId?: string;
  /** CloudWatch metric names to query, e.g. ["CPUUtilization", "NetworkIn"] */
  metrics: string[];
  /** Look-back window in hours (1, 6, or 24) */
  periodHours: number;
}

export interface AskPlan {
  targets: AwsInventoryServiceName[];
  questionType: "count" | "list" | "summary" | "metrics" | "k8s" | "unknown";
  region?: string;
  metricsQuery?: AskMetricsContext;
  k8sQuery?: AskK8sQuery;
  unsupportedReason?: string;
}

export interface AwsInventoryServiceResult {
  count: number;
  items: unknown[];
  error?: string;
}

export interface AwsInventorySnapshot {
  accountId?: string;
  accountArn?: string;
  region: string;
  generatedAt: string;
  services: Partial<Record<AwsInventoryServiceName, AwsInventoryServiceResult>>;
}
