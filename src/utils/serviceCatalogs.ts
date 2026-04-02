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
 *
 * All aws_cli() examples explicitly include --output json.
 * The aws_cli tool appends it automatically, but being explicit helps the LLM
 * understand it will always receive structured JSON back.
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
  aws_cli("aws elasticache describe-replication-groups --replication-group-id <name> --output json")
    → shows status, node type, MemberClusters (these are the CacheClusterId values for metrics)
  aws_cli("aws elasticache describe-cache-clusters --cache-cluster-id <member-id> --show-cache-node-info --output json")
    → node-level details, engine version, status
  aws_cli("aws cloudwatch list-metrics --namespace AWS/ElastiCache --output json")
    → shows every metric + exact dimension values CloudWatch is publishing right now

CLOUDWATCH NAMESPACE: AWS/ElastiCache
DIMENSION: CacheClusterId=<member-cluster-id>  (e.g. "myredis-001", "myredis-002")
  NOTE: Use MemberClusters[] values from describe-replication-groups, NOT the ReplicationGroupId itself.

KEY METRICS:
  CPUUtilization                    → overall CPU (all node types)
  EngineCPUUtilization              → Redis engine thread CPU (r6g, m6g, t4g — more accurate)
  CacheHits                         → successful key lookups (Sum)
  CacheMisses                       → failed key lookups (Sum)
  CurrConnections                   → active client connections (Average)
  Evictions                         → keys evicted due to maxmemory (Sum)
  BytesUsedForCache                 → memory used by data (Average)
  DatabaseMemoryUsagePercentage     → % of maxmemory used (Average)
  ReplicationLag                    → replica lag seconds (Maximum) — cluster mode disabled only
  NetworkBytesIn / NetworkBytesOut  → traffic volume (Sum)
  CacheHitRate                      → not a native metric; compute from CacheHits + CacheMisses

FORMULAS:
  Hit Rate (%) = CacheHits / (CacheHits + CacheMisses) × 100
  Free Memory  = maxmemory - BytesUsedForCache

COMMON QUERIES:
  cw_metrics(namespace="AWS/ElastiCache", metric="CacheHits",                   dimensions="CacheClusterId=<id>", statistic="Sum")
  cw_metrics(namespace="AWS/ElastiCache", metric="CacheMisses",                 dimensions="CacheClusterId=<id>", statistic="Sum")
  cw_metrics(namespace="AWS/ElastiCache", metric="CPUUtilization",              dimensions="CacheClusterId=<id>")
  cw_metrics(namespace="AWS/ElastiCache", metric="CurrConnections",             dimensions="CacheClusterId=<id>")
  cw_metrics(namespace="AWS/ElastiCache", metric="Evictions",                   dimensions="CacheClusterId=<id>", statistic="Sum")
  cw_metrics(namespace="AWS/ElastiCache", metric="DatabaseMemoryUsagePercentage", dimensions="CacheClusterId=<id>")

GOTCHAS:
  - Cluster mode ENABLED: each shard = separate CacheClusterId. Fetch metrics per shard.
  - Cluster mode DISABLED: usually 2 nodes (primary + replica). Query both.
  - CacheHits/CacheMisses may be 0 if cluster is idle — not an error.
  - T-family nodes (t2/t3/t4g): prefer EngineCPUUtilization over CPUUtilization.
  - AWS/ElastiCache metrics use 60s resolution — use period_minutes=1 or 5.
`,

  // ── ECS ───────────────────────────────────────────────────────────────────
  ecs: `
SERVICE: ECS (Elastic Container Service)
────────────────────────────────────────
DISCOVERY:
  ecs_describe()                                    → list all clusters
  ecs_describe(cluster="<name>")                    → list services in cluster
  ecs_describe(cluster="<name>", service="<svc>")   → full service detail: deployments, events, task status
  aws_cli("aws ecs list-tasks --cluster <c> --service-name <s> --output json")
    → running task ARNs
  aws_cli("aws ecs describe-tasks --cluster <c> --tasks <arn1> <arn2> --output json")
    → container exit codes, stoppedReason, health
  aws_cli("aws ecs describe-services --cluster <c> --services <svc> --output json")
    → service config, desired/running/pending counts, load balancers
  aws_cli("aws ecs describe-task-definition --task-definition <family>:<revision> --output json")
    → container definitions, CPU/memory limits, environment vars

CLOUDWATCH NAMESPACE: AWS/ECS  (Fargate: AWS/ECS + Container Insights)
DIMENSIONS: ClusterName=<name>, ServiceName=<name>

KEY METRICS:
  CPUUtilization        → % of reserved CPU used (Average)
  MemoryUtilization     → % of reserved memory used (Average)
  RunningTaskCount      → number of running tasks (Average)
  PendingTaskCount      → tasks waiting to start — if > 0, investigate capacity
  DesiredTaskCount      → target number of tasks

CONTAINER INSIGHTS (if enabled):
  namespace: ECS/ContainerInsights
  NetworkRxBytes, NetworkTxBytes, StorageReadBytes, StorageWriteBytes

DEPLOYMENT DIAGNOSIS:
  ecs_describe(cluster, service) → "deployments" array → PRIMARY vs ACTIVE
  Stuck deployment: PRIMARY taskCount < desiredCount + ACTIVE deployment still exists
  Check "events" array for "service was unable to place a task"

COMMON QUERIES:
  ecs_describe(cluster="<c>", service="<s>")
  cw_metrics(namespace="AWS/ECS", metric="CPUUtilization",    dimensions="ClusterName=<c>,ServiceName=<s>")
  cw_metrics(namespace="AWS/ECS", metric="MemoryUtilization", dimensions="ClusterName=<c>,ServiceName=<s>")
  cloudtrail(event_name="UpdateService", resource_name="<service>")
  aws_cli("aws ecs describe-services --cluster <c> --services <s> --output json")

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
  aws_cli("aws eks describe-cluster --name <cluster> --output json")
    → cluster status, version, endpoint, logging config
  aws_cli("aws eks list-nodegroups --cluster-name <cluster> --output json")
    → all node groups
  aws_cli("aws eks describe-nodegroup --cluster-name <cluster> --nodegroup-name <ng> --output json")
    → node group config, instance type, min/max/desired, health issues
  aws_cli("aws eks list-fargate-profiles --cluster-name <cluster> --output json")
  aws_cli("aws cloudwatch list-metrics --namespace ContainerInsights --dimensions Name=ClusterName,Value=<cluster> --output json")
    → all Container Insights metrics for this cluster

CLOUDWATCH NAMESPACE: ContainerInsights (if enabled)
DIMENSIONS: ClusterName=<name>, Namespace=<ns>, ServiceName=<name>

KEY METRICS (ContainerInsights):
  pod_cpu_utilization       → CPU % per pod
  pod_memory_utilization    → memory % per pod
  pod_network_rx_bytes      → inbound traffic
  node_cpu_utilization      → node CPU %
  node_memory_utilization   → node memory %
  node_filesystem_utilization → disk %

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
  aws_cli("aws eks describe-cluster --name <cluster> --output json")

GOTCHAS:
  - Restart count > 5 almost always means CrashLoop — get previous logs immediately.
  - "Evicted" pods: node ran out of memory/disk, not an app bug.
  - Check node conditions via: run_command("kubectl describe node <node> --context <ctx>")
`,

  // ── RDS / Aurora ──────────────────────────────────────────────────────────
  rds: `
SERVICE: RDS / Aurora
──────────────────────
DISCOVERY (IMPORTANT — always identify type first, run both in parallel):
  aws_cli("aws rds describe-db-instances --db-instance-identifier <name> --output json")
    → RDS MySQL / PostgreSQL instance  → use dimension: DBInstanceIdentifier=<name>
  aws_cli("aws rds describe-db-clusters --db-cluster-identifier <name> --output json")
    → Aurora cluster                   → use dimension: DBClusterIdentifier=<name>
  → One will succeed, one will return DBInstanceNotFoundFault / DBClusterNotFoundFault
  aws_cli("aws rds describe-db-instances --output json")
    → list ALL instances in the account (use when resource name is unknown)
  aws_cli("aws rds describe-db-clusters --output json")
    → list ALL Aurora clusters
  aws_cli("aws cloudwatch list-metrics --namespace AWS/RDS --dimensions Name=DBInstanceIdentifier,Value=<name> --output json")
    → verify exact metric names + confirm instance exists in CloudWatch
  pi_top_sql(instance="<db-id>")
    → top SQL by DB Load (Performance Insights) — best for "why is DB slow?"

CLOUDWATCH NAMESPACE: AWS/RDS
DIMENSIONS: DBInstanceIdentifier=<id>  or  DBClusterIdentifier=<id>

KEY METRICS:
  CPUUtilization                → % (Average)
  DatabaseConnections           → active connections (Average)
  FreeableMemory                → bytes (Average)
  FreeStorageSpace              → bytes (Average)
  ReadIOPS / WriteIOPS          → I/O ops/sec (Average)
  ReadLatency / WriteLatency    → seconds per op (Average)
  DBLoad                        → avg active sessions — Performance Insights (Average)
  ReplicaLag                    → replica lag seconds (Maximum)
  NetworkReceiveThroughput / NetworkTransmitThroughput

AURORA-SPECIFIC:
  AuroraReplicaLag          → replica lag ms
  BufferCacheHitRatio       → % reads from cache (higher = better)
  CommitLatency             → write commit latency ms
  ServerlessDatabaseCapacity → ACUs used (Aurora Serverless)

PERFORMANCE INSIGHTS:
  pi_top_sql(instance="<id>", top=10, since_hours=3)
  → top SQL by DB Load (avg active sessions) — USE THIS FIRST for slow DB

COMMON QUERIES:
  pi_top_sql(instance="<id>", top=10, since_hours=1)
  cw_metrics(namespace="AWS/RDS", metric="CPUUtilization",      dimensions="DBInstanceIdentifier=<id>")
  cw_metrics(namespace="AWS/RDS", metric="DatabaseConnections", dimensions="DBInstanceIdentifier=<id>")
  cw_metrics(namespace="AWS/RDS", metric="ReadLatency",         dimensions="DBInstanceIdentifier=<id>")
  cw_metrics(namespace="AWS/RDS", metric="DBLoad",              dimensions="DBInstanceIdentifier=<id>")
  aws_cli("aws rds describe-db-instances --db-instance-identifier <id> --output json")

GOTCHAS:
  - "too many connections" → DatabaseConnections near max_connections. Check instance class limit.
  - High CPUUtilization + low DBLoad → OS-level CPU. Look for table scans.
  - High DBLoad + normal CPU → lock waits. pi_top_sql will show wait events.
  - DBLoad metric requires Performance Insights to be enabled on the instance.
`,

  // ── ALB / Load Balancer ───────────────────────────────────────────────────
  alb: `
SERVICE: ALB / NLB (Application/Network Load Balancer)
────────────────────────────────────────────────────────
DISCOVERY:
  elb_health(load_balancer="<name>")        → target group health + unhealthy targets
  elb_health(target_group="<name>")         → health for specific target group
  aws_cli("aws elbv2 describe-load-balancers --names <name> --output json")
    → full ARN → extract suffix after "loadbalancer/" for CW dimensions
  aws_cli("aws elbv2 describe-target-groups --load-balancer-arn <arn> --output json")
    → all target groups for a load balancer
  aws_cli("aws elbv2 describe-target-health --target-group-arn <arn> --output json")
    → per-target health + reason for unhealthy targets
  aws_cli("aws elbv2 describe-listeners --load-balancer-arn <arn> --output json")
    → listener rules, ports, SSL certificates
  aws_cli("aws cloudwatch list-metrics --namespace AWS/ApplicationELB --dimensions Name=LoadBalancer,Value=app/<name>/<hash> --output json")
    → verify exact dimension value for metrics

CLOUDWATCH NAMESPACE: AWS/ApplicationELB  (NLB: AWS/NetworkELB)
DIMENSION: LoadBalancer=app/<name>/<hash>   ← ARN suffix AFTER "loadbalancer/"
           TargetGroup=targetgroup/<name>/<hash>

KEY METRICS:
  HTTPCode_Target_5XX_Count   → 5XX from backends (Sum)
  HTTPCode_Target_4XX_Count   → 4XX from backends (Sum)
  HTTPCode_ELB_5XX_Count      → 5XX from ALB itself (Sum)
  RequestCount                → total requests (Sum)
  TargetResponseTime          → backend latency (Average)
  HealthyHostCount            → healthy targets (Minimum)
  UnHealthyHostCount          → unhealthy targets (Maximum)
  ActiveConnectionCount       → concurrent connections (Sum)

STATISTIC GUIDE:
  Error counts (5XX, 4XX)     → statistic=Sum
  Latency (TargetResponseTime)→ statistic=Average
  Host counts                 → Minimum (HealthyHost), Maximum (UnHealthyHost)

COMMON QUERIES:
  elb_health(load_balancer="<name>")
  aws_cli("aws elbv2 describe-load-balancers --names <name> --output json")
  cw_metrics(namespace="AWS/ApplicationELB", metric="HTTPCode_Target_5XX_Count", dimensions="LoadBalancer=app/<name>/<hash>", statistic="Sum")
  cw_metrics(namespace="AWS/ApplicationELB", metric="TargetResponseTime",        dimensions="LoadBalancer=app/<name>/<hash>")
  cw_metrics(namespace="AWS/ApplicationELB", metric="HealthyHostCount",          dimensions="LoadBalancer=app/<name>/<hash>,TargetGroup=targetgroup/<tg>/<hash>", statistic="Minimum")

GOTCHAS:
  - CW dimension is the ARN SUFFIX, not the name. Strip everything before "loadbalancer/".
  - HTTPCode_ELB_5XX ≠ HTTPCode_Target_5XX. ELB 5XX = ALB itself failed (connection refused, timeout).
  - Get dimension from: aws_cli("aws elbv2 describe-load-balancers --names <name> --output json") → LoadBalancerArn field.
`,

  // ── EC2 / ASG ─────────────────────────────────────────────────────────────
  ec2_asg: `
SERVICE: EC2 / Auto Scaling Groups
────────────────────────────────────
DISCOVERY:
  asg_activity()                                → list all ASGs + instance health
  asg_activity(asg_name="<name>")              → scaling history + current config
  aws_cli("aws ec2 describe-instances --filters Name=tag:Name,Values=<name> --output json")
    → instances by tag, includes InstanceId, state, type, AZ
  aws_cli("aws ec2 describe-instances --instance-ids <id> --output json")
    → specific instance details
  aws_cli("aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names <name> --output json")
    → ASG config: min/max/desired, health check type, instances + health status
  aws_cli("aws ec2 describe-instance-status --instance-ids <id> --output json")
    → system/instance status checks — key for "is this instance healthy?"
  aws_cli("aws cloudwatch list-metrics --namespace AWS/EC2 --dimensions Name=InstanceId,Value=<id> --output json")
    → all available CW metrics for this instance

CLOUDWATCH NAMESPACE: AWS/EC2
DIMENSIONS: InstanceId=<id>  or  AutoScalingGroupName=<name>

KEY METRICS:
  CPUUtilization                    → % (Average)
  NetworkIn / NetworkOut            → bytes (Sum)
  DiskReadOps / DiskWriteOps        → I/O ops (Sum)
  StatusCheckFailed                 → 0=ok, 1=failed (Maximum) — critical health signal
  StatusCheckFailed_Instance        → guest OS check
  StatusCheckFailed_System          → host hardware check

ASG METRICS (namespace: AWS/AutoScaling, dim: AutoScalingGroupName):
  GroupDesiredCapacity      → target count
  GroupInServiceCapacity    → healthy running count
  GroupPendingCapacity      → launching count
  GroupTerminatingCapacity  → terminating count

COMMON QUERIES:
  asg_activity(asg_name="<name>")
  aws_cli("aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names <name> --output json")
  cw_metrics(namespace="AWS/EC2",          metric="CPUUtilization",    dimensions="AutoScalingGroupName=<name>")
  cw_metrics(namespace="AWS/EC2",          metric="StatusCheckFailed", dimensions="InstanceId=<id>", statistic="Maximum")
  cloudtrail(event_name="TerminateInstances")
`,

  // ── Lambda ────────────────────────────────────────────────────────────────
  lambda: `
SERVICE: Lambda
────────────────
DISCOVERY:
  aws_cli("aws lambda list-functions --output json")
    → all functions with runtime, memory, timeout, last-modified
  aws_cli("aws lambda get-function --function-name <name> --output json")
    → config + code location + concurrency settings
  aws_cli("aws lambda get-function-configuration --function-name <name> --output json")
    → timeout, memory, environment variables, layers, VPC config
  aws_cli("aws lambda get-function-concurrency --function-name <name> --output json")
    → reserved concurrency limit (if set)
  aws_cli("aws lambda list-event-source-mappings --function-name <name> --output json")
    → Kinesis/DynamoDB/SQS triggers + consumer lag
  cw_logs(log_group="/aws/lambda/<function-name>")
    → function logs including errors and Init Duration (cold starts)

CLOUDWATCH NAMESPACE: AWS/Lambda
DIMENSIONS: FunctionName=<name>  or  FunctionName=<name>,Resource=<name>:<alias>

KEY METRICS:
  Invocations           → total calls (Sum)
  Errors                → failed invocations (Sum)
  Throttles             → rate-limited invocations (Sum)
  Duration              → execution time ms (Average)
  ConcurrentExecutions  → simultaneous executions (Maximum)
  IteratorAge           → Kinesis/DynamoDB stream lag ms (Maximum)

FORMULAS:
  Error Rate    = Errors / Invocations × 100
  Throttle Rate = Throttles / (Invocations + Throttles) × 100

COMMON QUERIES:
  aws_cli("aws lambda get-function-configuration --function-name <name> --output json")
  cw_metrics(namespace="AWS/Lambda", metric="Errors",       dimensions="FunctionName=<name>", statistic="Sum")
  cw_metrics(namespace="AWS/Lambda", metric="Duration",     dimensions="FunctionName=<name>")
  cw_metrics(namespace="AWS/Lambda", metric="Throttles",    dimensions="FunctionName=<name>", statistic="Sum")
  cw_logs(log_group="/aws/lambda/<name>", filter_pattern="ERROR", since_hours=1)

GOTCHAS:
  - "Task timed out" = Duration > configured timeout. Check get-function-configuration.
  - Throttles spike → concurrent execution limit hit. Check account-level limit.
  - Cold starts appear as "Init Duration" lines in CloudWatch Logs, not a CW metric.
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
    NumberOfMessagesSent                  → throughput in (Sum)
    NumberOfMessagesDeleted               → throughput out (Sum)
    NumberOfMessagesNotVisible            → in-flight messages (Maximum)
  DISCOVERY:
    aws_cli("aws sqs list-queues --output json")
    aws_cli("aws sqs get-queue-url --queue-name <name> --output json")
    aws_cli("aws sqs get-queue-attributes --queue-url <url> --attribute-names All --output json")
      → ApproximateNumberOfMessages, VisibilityTimeout, RedrivePolicy, etc.

MSK (Kafka):
  NAMESPACE: AWS/Kafka  DIMENSION: Cluster Name=<name>, Topic=<topic>
  KEY METRICS:
    KafkaDataLogsDiskUsed   → disk % used (Maximum)
    GlobalPartitionCount    → total partitions
    GlobalTopicCount        → total topics
    EstimatedMaxTimeLag     → consumer lag estimate ms (Maximum)
    SumOffsetLag            → total consumer lag (Maximum)
  DISCOVERY:
    aws_cli("aws kafka list-clusters --output json")
    aws_cli("aws kafka describe-cluster --cluster-arn <arn> --output json")
    aws_cli("aws kafka list-nodes --cluster-arn <arn> --output json")
      → broker IDs, instance type, storage, status
`,

  // ── Networking ────────────────────────────────────────────────────────────
  networking: `
SERVICE: VPC / Route 53 / Networking
──────────────────────────────────────
DISCOVERY:
  route53_check(domain="<domain>")            → DNS records for a domain
  route53_check(zone_id="<zone>")             → all records in a hosted zone
  aws_cli("aws ec2 describe-vpcs --output json")
    → all VPCs with CIDR, state, tags
  aws_cli("aws ec2 describe-vpcs --vpc-ids <vpc-id> --output json")
    → specific VPC details
  aws_cli("aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> --output json")
    → subnets with AZ, available IPs, route table associations
  aws_cli("aws ec2 describe-security-groups --filters Name=vpc-id,Values=<vpc-id> --output json")
    → all security groups + inbound/outbound rules
  aws_cli("aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=<vpc-id> --output json")
    → NAT gateway IDs and state
  aws_cli("aws ec2 describe-route-tables --filters Name=vpc-id,Values=<vpc-id> --output json")
    → route tables + routes (0.0.0.0/0 via NAT or IGW)

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
  - Route 53 health checks ≠ target group health. Check both for DNS-routed services.
  - Security group rules are stateful — check both inbound AND outbound.
  - NAT gateway ErrorPortAllocation > 0 = port exhaustion. Scale out or use multiple NAT gateways.
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
  cloudtrail(since_hours=3)                                        → all changes last 3h
  cloudtrail(event_name="UpdateService", resource_name="<svc>")    → ECS deploys
  cloudtrail(event_name="UpdateFunctionCode", since_hours=6)       → Lambda deployments
  cloudtrail(username="<role-or-user>", since_hours=24)            → all actions by a principal
  aws_cli("aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<name> --output json")
    → alternative: raw CloudTrail API with full event details

GOTCHAS:
  - Events appear with 5-15 min delay in CloudTrail.
  - Management events only (not S3 GetObject / data events) unless data events enabled.
  - "errorCode" field in events = the action was denied or failed — key for IAM debugging.
`,

  // ── General fallback ──────────────────────────────────────────────────────
  general: `
GENERAL AWS REFERENCE:
  Discovery:
    aws_cli("aws sts get-caller-identity --output json")
      → confirms credentials + shows account ID + role/user ARN
    aws_query(type="AWS::<Service>::<Resource>", name_filter="<name>")
      → resource inventory for any AWS CloudFormation type
    aws_cli("aws cloudwatch list-metrics --namespace <ns> --output json")
      → discover exact metric names + dimension values before calling cw_metrics
  Changes:
    cloudtrail(since_hours=3)
      → covers all services — best first step for "what changed?" questions
  Quotas:
    aws_cli("aws service-quotas list-service-quotas --service-code <code> --output json")
    aws_cli("aws service-quotas list-aws-default-service-quotas --service-code <code> --output json")
  Tags:
    aws_cli("aws resourcegroupstaggingapi get-resources --tag-filters Key=<k>,Values=<v> --output json")
      → find resources by tag across all services
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
