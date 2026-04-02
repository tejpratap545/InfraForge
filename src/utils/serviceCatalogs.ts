/**
 * serviceCatalogs.ts
 *
 * Per-service reference blocks injected into the LLM system prompt.
 * Each block gives the LLM:
 *   - Exact CloudWatch namespace + key metrics + dimension format
 *   - Hit rate / derived metric formulas
 *   - Discovery CLI commands to find resource IDs
 *   - Common diagnostic queries
 *   - Gotchas specific to that service
 */

import type { ServiceGroup } from "./serviceRouter";

// ─── Per-service reference blocks ─────────────────────────────────────────────

const CATALOGS: Partial<Record<ServiceGroup, string>> = {

  // ── ElastiCache / Redis / Valkey ───────────────────────────────────────────
  elasticache: `
SERVICE: ElastiCache / Redis / Valkey
────────────────────────────────────
DISCOVERY (always start here if you don't have node IDs):
  aws_cli("aws elasticache describe-replication-groups --output json")
    → lists all replication groups → pick the right one → note MemberClusters[]
  aws_cli("aws elasticache describe-replication-groups --replication-group-id <name>")
    → shows status, node type, MemberClusters (these are the CacheClusterId values for metrics)
  aws_cli("aws cloudwatch list-metrics --namespace AWS/ElastiCache")
    → shows every metric + exact dimension values CloudWatch is publishing right now

CLOUDWATCH NAMESPACE: AWS/ElastiCache
DIMENSION: CacheClusterId=<member-cluster-id>  (e.g. "myredis-001", "myredis-002")
  NOTE: Use MemberClusters[] values, NOT the ReplicationGroupId itself.

KEY METRICS:
  CPUUtilization          → overall CPU (all node types)
  EngineCPUUtilization    → Redis engine thread CPU (r6g, m6g, t4g nodes — more accurate)
  CacheHits               → successful key lookups (Sum)
  CacheMisses             → failed key lookups (Sum)
  CurrConnections         → active client connections (Average)
  Evictions               → keys evicted due to maxmemory (Sum)
  BytesUsedForCache       → memory used by data (Average)
  DatabaseMemoryUsagePercentage → % of maxmemory used (Average)
  ReplicationLag          → replica lag in seconds (Maximum) — cluster mode disabled only
  NetworkBytesIn/Out      → traffic volume (Sum)
  CacheHitRate            → not a native metric; compute as CacheHits / (CacheHits + CacheMisses)

FORMULAS:
  Hit Rate (%) = CacheHits / (CacheHits + CacheMisses) × 100
  Free Memory  = maxmemory - BytesUsedForCache

COMMON QUERIES:
  cw_metrics(namespace="AWS/ElastiCache", metric="CacheHits",      dimensions="CacheClusterId=<id>", statistic="Sum")
  cw_metrics(namespace="AWS/ElastiCache", metric="CacheMisses",    dimensions="CacheClusterId=<id>", statistic="Sum")
  cw_metrics(namespace="AWS/ElastiCache", metric="CPUUtilization",  dimensions="CacheClusterId=<id>")
  cw_metrics(namespace="AWS/ElastiCache", metric="CurrConnections", dimensions="CacheClusterId=<id>")
  cw_metrics(namespace="AWS/ElastiCache", metric="Evictions",       dimensions="CacheClusterId=<id>", statistic="Sum")

GOTCHAS:
  - Cluster mode ENABLED: each shard = separate CacheClusterId. Fetch metrics per shard.
  - Cluster mode DISABLED: usually 2 nodes (primary + replica). Query both.
  - CacheHits/CacheMisses may be 0 if cluster is idle → not an error.
  - T-family nodes (t2/t3/t4g): prefer EngineCPUUtilization over CPUUtilization.
  - AWS/ElastiCache metrics use 60s resolution — use period_minutes=1 or 5.
`,

  // ── ECS ───────────────────────────────────────────────────────────────────
  ecs: `
SERVICE: ECS (Elastic Container Service)
────────────────────────────────────────
DISCOVERY:
  ecs_describe()                                   → list all clusters
  ecs_describe(cluster="<name>")                   → list services in cluster
  ecs_describe(cluster="<name>", service="<svc>")  → full service detail: deployments, events, task status
  aws_cli("aws ecs list-tasks --cluster <c> --service-name <s>") → running task ARNs
  aws_cli("aws ecs describe-tasks --cluster <c> --tasks <arn>")  → container exit codes, stoppedReason

CLOUDWATCH NAMESPACE: AWS/ECS  (Fargate: AWS/ECS + Container Insights)
DIMENSIONS: ClusterName=<name>, ServiceName=<name>

KEY METRICS:
  CPUUtilization          → % of reserved CPU used (Average)
  MemoryUtilization       → % of reserved memory used (Average)
  RunningTaskCount        → number of running tasks (Average)
  PendingTaskCount        → tasks waiting to start — if > 0, investigate capacity
  DesiredTaskCount        → target number of tasks

CONTAINER INSIGHTS (if enabled):
  namespace: ECS/ContainerInsights
  NetworkRxBytes, NetworkTxBytes, StorageReadBytes, StorageWriteBytes

DEPLOYMENT DIAGNOSIS:
  ecs_describe(cluster, service) → look at "deployments" array → PRIMARY vs ACTIVE
  A stuck deployment: PRIMARY taskCount < desiredCount + ACTIVE deployment still exists
  Rollback: check "events" array for "service was unable to place a task"

COMMON QUERIES:
  ecs_describe(cluster="<c>", service="<s>")
  cw_metrics(namespace="AWS/ECS", metric="CPUUtilization",    dimensions="ClusterName=<c>,ServiceName=<s>")
  cw_metrics(namespace="AWS/ECS", metric="MemoryUtilization", dimensions="ClusterName=<c>,ServiceName=<s>")
  cloudtrail(event_name="UpdateService", resource_name="<service>")

GOTCHAS:
  - "service was unable to place a task" → capacity issue or constraint mismatch
  - Exit code 137 → OOM killed. Exit code 1 → app crash.
  - stoppedReason in task details is the most useful field for debugging crashes.
`,

  // ── EKS / Kubernetes ──────────────────────────────────────────────────────
  eks_k8s: `
SERVICE: EKS / Kubernetes
──────────────────────────
DISCOVERY:
  k8s_pods(namespace="<ns>")                          → all pods + restart counts + status
  k8s_pods(namespace="<ns>", selector="app=<name>")   → pods for a specific app
  k8s_events(namespace="<ns>", severity="warning")    → recent warning events
  k8s_logs(pod="<name>", namespace="<ns>", grep="error|panic|fatal")
  k8s_logs(pod="<name>", namespace="<ns>", previous="true")  → logs from crashed container
  aws_cli("aws eks describe-cluster --name <cluster>")
  aws_cli("aws eks list-nodegroups --cluster-name <cluster>")

CLOUDWATCH NAMESPACE: ContainerInsights (if enabled)
DIMENSIONS: ClusterName=<name>, Namespace=<ns>, ServiceName=<name>

KEY METRICS (ContainerInsights):
  pod_cpu_utilization       → CPU % per pod
  pod_memory_utilization    → memory % per pod
  pod_network_rx_bytes      → inbound traffic
  node_cpu_utilization      → node CPU %
  node_memory_utilization   → node memory %

FAILURE PATTERNS:
  CrashLoopBackOff  → app keeps crashing. Check: k8s_logs(previous=true) for exit reason
  OOMKilled         → memory limit exceeded. Check: k8s_pods for lastState.terminated.reason
  Pending           → can't schedule. Check: k8s_events for "Insufficient cpu/memory"
  ImagePullBackOff  → bad image tag or ECR permissions

COMMON QUERIES:
  k8s_pods(namespace="production")
  k8s_events(namespace="production", severity="warning", since="2h")
  k8s_logs(pod="<name>", namespace="production", grep="error", tail="100")
  k8s_logs(pod="<crashed-pod>", namespace="production", previous="true")

GOTCHAS:
  - Restart count > 5 almost always means CrashLoop — get previous logs immediately.
  - "Evicted" pods: node ran out of memory/disk, not an app bug.
  - Check node conditions: aws_cli("kubectl describe node <node>") via run_command.
`,

  // ── RDS / Aurora ──────────────────────────────────────────────────────────
  rds: `
SERVICE: RDS / Aurora
──────────────────────
DISCOVERY:
  aws_cli("aws rds describe-db-instances --output json")
  aws_cli("aws rds describe-db-clusters --output json")   ← Aurora clusters
  pi_top_sql(instance="<db-id>")                          ← top SQL by DB load (Performance Insights)

CLOUDWATCH NAMESPACE: AWS/RDS
DIMENSIONS: DBInstanceIdentifier=<id>  or  DBClusterIdentifier=<id>

KEY METRICS:
  CPUUtilization          → % (Average)
  DatabaseConnections     → active connections (Average)
  FreeableMemory          → bytes (Average)
  FreeStorageSpace        → bytes (Average)
  ReadIOPS / WriteIOPS    → I/O operations per second (Average)
  ReadLatency / WriteLatency → seconds (Average)
  DBLoad                  → average active sessions (Average) — PI metric
  ReplicaLag              → replica lag seconds (Maximum)
  NetworkReceiveThroughput / NetworkTransmitThroughput

AURORA-SPECIFIC:
  namespace: AWS/RDS  (same, filter by cluster)
  AuroraReplicaLag        → replica lag ms
  BufferCacheHitRatio     → % of reads served from cache (higher = better)
  CommitLatency           → write commit latency ms

PERFORMANCE INSIGHTS:
  pi_top_sql(instance="<id>", top=10, since_hours=3)
  → returns top SQL by DB Load (avg active sessions)
  → best tool for "why is the DB slow?" questions

COMMON QUERIES:
  cw_metrics(namespace="AWS/RDS", metric="CPUUtilization",       dimensions="DBInstanceIdentifier=<id>")
  cw_metrics(namespace="AWS/RDS", metric="DatabaseConnections",  dimensions="DBInstanceIdentifier=<id>")
  cw_metrics(namespace="AWS/RDS", metric="ReadLatency",          dimensions="DBInstanceIdentifier=<id>")
  pi_top_sql(instance="<id>", top=10, since_hours=1)

GOTCHAS:
  - "too many connections" → DatabaseConnections near max_connections. Check instance class limit.
  - High CPUUtilization + low DBLoad → OS-level CPU, not SQL. Check for index scans.
  - High DBLoad + normal CPU → lock waits. pi_top_sql will show wait events.
`,

  // ── ALB / Load Balancer ───────────────────────────────────────────────────
  alb: `
SERVICE: ALB / NLB (Application/Network Load Balancer)
────────────────────────────────────────────────────────
DISCOVERY:
  elb_health(load_balancer="<name>")        → target group health + unhealthy targets
  elb_health(target_group="<name>")         → health for specific target group
  aws_query(type="AWS::ElasticLoadBalancingV2::LoadBalancer", name_filter="<name>")
    → get full ARN → extract suffix after "loadbalancer/" for dimensions

CLOUDWATCH NAMESPACE: AWS/ApplicationELB  (NLB: AWS/NetworkELB)
DIMENSION: LoadBalancer=app/<name>/<hash>   (the suffix of the ALB ARN after "loadbalancer/")
           TargetGroup=targetgroup/<name>/<hash>

KEY METRICS:
  HTTPCode_Target_5XX_Count   → 5XX from backends (Sum)
  HTTPCode_Target_4XX_Count   → 4XX from backends (Sum)
  HTTPCode_ELB_5XX_Count      → 5XX generated by ALB itself (Sum)
  RequestCount                → total requests (Sum)
  TargetResponseTime          → p95/avg backend latency (Average or p99)
  HealthyHostCount            → healthy targets in target group (Minimum)
  UnHealthyHostCount          → unhealthy targets (Maximum)
  ActiveConnectionCount       → concurrent connections (Sum)
  NewConnectionCount          → new connections per period (Sum)

STATISTIC GUIDE:
  Error counts (5XX, 4XX) → statistic=Sum
  Latency (TargetResponseTime) → statistic=Average or p99
  Host counts → statistic=Minimum (HealthyHost) or Maximum (UnHealthyHost)

COMMON QUERIES:
  elb_health(load_balancer="<name>")
  cw_metrics(namespace="AWS/ApplicationELB", metric="HTTPCode_Target_5XX_Count", dimensions="LoadBalancer=app/<name>/<hash>", statistic="Sum")
  cw_metrics(namespace="AWS/ApplicationELB", metric="TargetResponseTime",        dimensions="LoadBalancer=app/<name>/<hash>")
  cw_metrics(namespace="AWS/ApplicationELB", metric="HealthyHostCount",          dimensions="LoadBalancer=app/<name>/<hash>,TargetGroup=targetgroup/<tg>/<hash>", statistic="Minimum")

GOTCHAS:
  - Dimension is the ARN SUFFIX, not the name. Get it via aws_query then strip "arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/".
  - HTTPCode_ELB_5XX ≠ HTTPCode_Target_5XX. ELB 5XX means ALB itself errored (connection refused, timeout before backend responded).
  - UnHealthyHostCount=0 means all targets healthy. Check with elb_health for actual reasons.
`,

  // ── EC2 / ASG ─────────────────────────────────────────────────────────────
  ec2_asg: `
SERVICE: EC2 / Auto Scaling Groups
────────────────────────────────────
DISCOVERY:
  asg_activity()                            → list all ASGs + instance health
  asg_activity(asg_name="<name>")          → scaling history + current config
  aws_cli("aws ec2 describe-instances --filters Name=tag:Name,Values=<name>")
  aws_cli("aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names <name>")

CLOUDWATCH NAMESPACE: AWS/EC2
DIMENSIONS: InstanceId=<id>  or  AutoScalingGroupName=<name>

KEY METRICS:
  CPUUtilization          → % (Average)
  NetworkIn / NetworkOut  → bytes (Sum)
  DiskReadOps / DiskWriteOps → I/O ops (Sum)
  StatusCheckFailed       → 0=ok, 1=failed (Maximum) — critical health signal
  StatusCheckFailed_Instance / StatusCheckFailed_System

ASG-SPECIFIC:
  GroupDesiredCapacity    → target instance count
  GroupInServiceCapacity  → healthy running instances
  GroupPendingCapacity    → instances launching
  GroupTerminatingCapacity→ instances terminating

SCALING DIAGNOSIS:
  asg_activity(asg_name="<name>") → look for recent scale-in/out events + Cause field
  cloudtrail(event_name="TerminateInstances") → who/what terminated instances

COMMON QUERIES:
  asg_activity(asg_name="<name>")
  cw_metrics(namespace="AWS/EC2", metric="CPUUtilization",    dimensions="AutoScalingGroupName=<name>")
  cw_metrics(namespace="AWS/EC2", metric="StatusCheckFailed", dimensions="InstanceId=<id>", statistic="Maximum")
`,

  // ── Lambda ────────────────────────────────────────────────────────────────
  lambda: `
SERVICE: Lambda
────────────────
DISCOVERY:
  aws_cli("aws lambda list-functions --output json")
  aws_cli("aws lambda get-function --function-name <name>")
  aws_cli("aws lambda get-function-configuration --function-name <name>")
  cw_logs(log_group="/aws/lambda/<function-name>")

CLOUDWATCH NAMESPACE: AWS/Lambda
DIMENSIONS: FunctionName=<name>  or  FunctionName=<name>,Resource=<name>:<alias>

KEY METRICS:
  Invocations         → total calls (Sum)
  Errors              → failed invocations (Sum)
  Throttles           → rate-limited invocations (Sum)
  Duration            → execution time ms (Average / p99)
  ConcurrentExecutions→ simultaneous executions (Maximum)
  IteratorAge         → Kinesis/DynamoDB stream lag ms (Maximum)
  InitDuration        → cold start duration ms (in logs, not CW metric)

ERROR RATE = Errors / Invocations × 100
THROTTLE RATE = Throttles / (Invocations + Throttles) × 100

COMMON QUERIES:
  cw_metrics(namespace="AWS/Lambda", metric="Errors",       dimensions="FunctionName=<name>", statistic="Sum")
  cw_metrics(namespace="AWS/Lambda", metric="Duration",     dimensions="FunctionName=<name>")
  cw_metrics(namespace="AWS/Lambda", metric="Throttles",    dimensions="FunctionName=<name>", statistic="Sum")
  cw_logs(log_group="/aws/lambda/<name>", filter_pattern="ERROR", since_hours=1)

GOTCHAS:
  - Task timed out = Duration > configured timeout (check GetFunctionConfiguration).
  - Throttles spike → concurrent execution limit hit. Check account limit.
  - Cold starts in Duration logs: look for "Init Duration" in CW Logs.
`,

  // ── Messaging (SQS / SNS / MSK) ───────────────────────────────────────────
  messaging: `
SERVICE: SQS / SNS / MSK (Kafka)
──────────────────────────────────
SQS:
  NAMESPACE: AWS/SQS  DIMENSION: QueueName=<name>
  KEY METRICS:
    ApproximateNumberOfMessagesVisible    → queue backlog (Maximum)
    ApproximateAgeOfOldestMessage         → oldest message age seconds (Maximum)
    NumberOfMessagesSent / Deleted        → throughput (Sum)
    NumberOfMessagesNotVisible            → in-flight messages (Maximum)
  DISCOVERY:
    aws_cli("aws sqs list-queues")
    aws_cli("aws sqs get-queue-attributes --queue-url <url> --attribute-names All")

MSK (Kafka):
  NAMESPACE: AWS/Kafka  DIMENSION: Cluster Name=<name>, Topic=<topic>
  KEY METRICS:
    KafkaDataLogsDiskUsed → disk % used (Maximum)
    GlobalPartitionCount  → total partitions
    GlobalTopicCount      → total topics
    EstimatedMaxTimeLag   → consumer lag estimate ms (Maximum)
    SumOffsetLag          → total consumer lag (Maximum)
  DISCOVERY:
    aws_cli("aws kafka list-clusters")
    aws_cli("aws kafka describe-cluster --cluster-arn <arn>")
`,

  // ── Networking ────────────────────────────────────────────────────────────
  networking: `
SERVICE: VPC / Route 53 / Networking
──────────────────────────────────────
DISCOVERY:
  route53_check(domain="<domain>")          → DNS records for a domain
  route53_check(zone_id="<zone>")           → all records in a hosted zone
  aws_cli("aws ec2 describe-vpcs")
  aws_cli("aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id>")
  aws_cli("aws ec2 describe-security-groups --filters Name=vpc-id,Values=<vpc-id>")

VPC FLOW LOGS:
  cw_logs(log_group="<vpc-flow-log-group>", filter_pattern="REJECT")

NAT GATEWAY:
  NAMESPACE: AWS/NATGateway  DIMENSION: NatGatewayId=<id>
  KEY METRICS: ActiveConnectionCount, BytesInFromSource, BytesOutToDestination, ErrorPortAllocation

NETWORK DIAGNOSTICS:
  run_command("dig <domain> +short")
  run_command("curl -I --connect-timeout 5 https://<endpoint>")
  run_command("nc -zv <host> <port>")

GOTCHAS:
  - Route 53 health checks ≠ target group health. Check both for DNS-based routing issues.
  - Security group rules are stateful — check both inbound AND outbound.
`,

  // ── CloudTrail (change history) ───────────────────────────────────────────
  cloudtrail: `
SERVICE: CloudTrail (API audit / change history)
──────────────────────────────────────────────────
USE WHEN: "what changed?", "who deployed?", "recent config changes", correlating incident timing

TOOL: cloudtrail(event_name?, resource_name?, username?, since_hours?, max_results?)

COMMON EVENT NAMES BY SERVICE:
  ECS:          UpdateService, RegisterTaskDefinition, CreateService, DeleteService
  RDS:          ModifyDBInstance, CreateDBSnapshot, RebootDBInstance, FailoverDBCluster
  ElastiCache:  ModifyReplicationGroup, RebootCacheCluster, DeleteReplicationGroup
  EC2/ASG:      RunInstances, TerminateInstances, UpdateAutoScalingGroup, PutScalingPolicy
  Lambda:       UpdateFunctionCode, UpdateFunctionConfiguration, AddPermission
  IAM:          AttachRolePolicy, CreateRole, AssumeRole, PutRolePolicy
  ALB:          ModifyTargetGroup, ModifyListener, RegisterTargets, DeregisterTargets
  EKS:          UpdateNodegroupConfig, CreateNodegroup, UpdateClusterVersion
  General:      PutBucketPolicy, CreateBucket, DeleteBucket, PutItem

COMMON QUERIES:
  cloudtrail(since_hours=3)                                      → all changes in last 3h
  cloudtrail(event_name="UpdateService", resource_name="<svc>")  → ECS deploys
  cloudtrail(event_name="UpdateFunctionCode", since_hours=6)     → Lambda deployments
  cloudtrail(username="<role-or-user>", since_hours=24)          → all actions by a principal

GOTCHAS:
  - Events appear with 5-15 min delay in CloudTrail.
  - Management events only (not data events like S3 GetObject) unless data events enabled.
  - "errorCode" field in events = the action was denied or failed — important for IAM debugging.
`,

  // ── General fallback ──────────────────────────────────────────────────────
  general: `
GENERAL AWS REFERENCE:
  - For any resource inventory: aws_query(type="AWS::<Service>::<Resource>", name_filter="<name>")
  - For metrics: first run aws_cli("aws cloudwatch list-metrics --namespace <ns>") to discover exact metric names + dimensions
  - For recent changes: cloudtrail(since_hours=3) covers all services
  - For account identity: aws_cli("aws sts get-caller-identity")
  - For service quotas: aws_cli("aws service-quotas list-service-quotas --service-code <code>")
`,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the service-specific reference block to inject into the LLM prompt.
 * Returns only the catalogs for the detected service groups.
 */
export function buildServiceContext(groups: ServiceGroup[]): string {
  const blocks = groups
    .map((g) => CATALOGS[g])
    .filter((b): b is string => Boolean(b));

  if (blocks.length === 0) return CATALOGS.general ?? "";

  return `═══ SERVICE REFERENCE (for this question) ═════════════════════════════════\n` +
    blocks.join("\n") +
    `═══════════════════════════════════════════════════════════════════════════════`;
}
