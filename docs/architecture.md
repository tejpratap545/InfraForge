# infra-copilot — Architecture & Flows

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI  (src/cli/index.ts)                                             │
│  create · plan · apply · update · ask · debug · diagnose             │
│  Global: --tenant-id · --region · --engine · --tf-dir                │
└───────────────────────┬──────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  InfraWorkflow  (src/workflows/infraWorkflow.ts)                     │
│  Rate limits · subscription checks · tracing · telemetry             │
└──┬───────┬───────┬───────┬───────┬───────────────────────────────────┘
   │       │       │       │       │
   ▼       ▼       ▼       ▼       ▼
 create  create  update  debug  ask /
  (tf)  (aws)   (patch)        diagnose
```

---

## Agentic Design

All agents follow the same **ReAct loop** pattern (Reason + Act):

```
while not done:
    LLM receives:  system prompt + tool catalog + evidence board + step history
    LLM returns:   { thought, tool, params }   ← single call
                or { thought, calls: [...] }   ← parallel fan-out (up to 8)
                or { thought, done: true, answer/report/... }
    Tool(s) execute (parallel when possible), results appended to history
    Evidence tracker extracts key findings (errors, deploys, crashes)
    History compressed (last 5 full · older summarised to key lines)
```

No cases, no pre-wired data sources, no hardcoded field extraction.
The LLM decides at each step what to run and when it has enough information.

---

## Agents

| Agent | Pattern | Responsibility |
|-------|---------|---------------|
| `ClarifyAgent` | ReAct · `ask_user` tool | Interactively gathers requirements before planning. LLM asks ONE question at a time and concludes with enriched description + resource types. |
| `PlannerAgent` | Single LLM call | Enriched description → Terraform HCL files (create) or file patches (update). Uses LCS unified diff for display. |
| `AwsPlannerAgent` | Single LLM call | Enriched description → Cloud Control API call plan |
| `ExecutorAgent` | Deterministic | Runs `terraform init / plan / apply` via TerraformMcpService |
| `DiagnoseAgent` | ReAct · 16 tools · evidence board | Senior SRE investigation engine. 4-phase methodology: TRIAGE → CORRELATE → HYPOTHESIZE → ROOT CAUSE. Up to 25 steps with pattern recognition, anti-pattern guards, and truncation auto-retry. |
| `AskAgent` | ReAct · 16 tools | LLM answers AWS inventory / metrics / k8s questions by querying live data. No pre-classification. |

---

## DiagnoseAgent — SRE Investigation Engine

```
"Why is checkout latency spiking?"
         │
         ▼
  Phase 1: TRIAGE (step 1 — parallel fan-out 4-6 calls)
  ┌────────────────────────────────────────────────────────────┐
  │  cw_metrics(5XX)    elb_health(lb)    cloudtrail(3h)      │
  │  cw_metrics(latency) ecs_describe(svc) cw_logs(errors)    │
  └────────────────────────────┬───────────────────────────────┘
                               │
    Evidence Board auto-extracts: errors, deploys, crashes, spikes
                               │
         ▼
  Phase 2: CORRELATE (steps 2-5)
  ┌────────────────────────────────────────────────────────────┐
  │  Align timestamps: when did anomaly start?                 │
  │  Cross-reference: deploy time vs first error               │
  │  Separate cause from symptom (high CPU = symptom, not root)│
  └────────────────────────────┬───────────────────────────────┘
                               │
         ▼
  Phase 3: HYPOTHESIS (steps 6-12)
  ┌────────────────────────────────────────────────────────────┐
  │  "I think the new deployment broke health checks because..."│
  │  Run ONE query to confirm/deny. Pivot if disproved.        │
  └────────────────────────────┬───────────────────────────────┘
                               │
         ▼
  Phase 4: ROOT CAUSE (steps 13+)
  ┌────────────────────────────────────────────────────────────┐
  │  ## Incident Summary (severity, impact, duration)          │
  │  ## Root Cause (specific component + evidence)             │
  │  ## Evidence Chain (numbered, timestamped)                  │
  │  ## Timeline (minute-by-minute)                            │
  │  ## Remediation (immediate + permanent + prevention)       │
  └────────────────────────────────────────────────────────────┘
```

### Incident Pattern Recognition

The agent recognizes 5 common patterns and adjusts its investigation:

| Pattern | Signal | Verification Tools |
|---------|--------|-------------------|
| Deploy-related | Anomaly starts within 30 min of deploy | `cloudtrail` → `ecs_describe` → compare timestamps |
| Resource exhaustion | Gradual ramp-up, not sudden step | `cw_metrics` time series for ramp pattern |
| Dependency failure | Connection errors, DNS failures in logs | `cw_logs` → `route53_check` → downstream health |
| Traffic spike | Sudden request count increase, all targets | `cw_metrics(RequestCount)` → baseline comparison |
| Single-host/AZ | Errors from specific targets only | `elb_health` → host-level metrics/logs |

### Evidence Board

Auto-extracts key findings from every tool result:
- **Critical**: 5XX errors, CrashLoopBackOff, OOMKilled, unhealthy targets, stopped tasks
- **Warning**: Deployments, config changes, scaling events
- **Info**: Metric summaries (max/avg values)

Presented to the LLM at every step so it never loses important signals during history compression.

---

## Shared Tool Set (`src/services/diagnoseTools.ts`)

### Core Tools

| Tool | What it does | SDK |
|------|-------------|-----|
| `run_command(command)` | Any read-only shell cmd: `dig`, `curl`, `nc`, `traceroute` | child_process |
| `aws_query(type, ...)` | List AWS resources via Cloud Control SDK | @aws-sdk/client-cloudcontrol |
| `aws_get(type, id, ...)` | Fetch full properties of one AWS resource | @aws-sdk/client-cloudcontrol |
| `ec2_exec(instance_id, cmd)` | Run command inside EC2 via SSM SDK (no SSH/CLI needed) | @aws-sdk/client-ssm |

### AWS Observability Tools

| Tool | What it does | SDK |
|------|-------------|-----|
| `cw_metrics(namespace, metric, ...)` | CloudWatch metric statistics (any unit — not restricted to Percent) | @aws-sdk/client-cloudwatch |
| `cw_logs(log_group, ...)` | CloudWatch Logs search (up to 100 events) | @aws-sdk/client-cloudwatch-logs |
| `pi_top_sql(instance, ...)` | Performance Insights — top SQL by DB load (AAS) | @aws-sdk/client-pi |

### AWS Infrastructure Tools

| Tool | What it does | SDK |
|------|-------------|-----|
| `ecs_describe(cluster?, service?, task_id?)` | ECS clusters → services → tasks with deployments, events, stopped reasons | @aws-sdk/client-ecs |
| `elb_health(load_balancer?, target_group?)` | ALB/NLB target group health with reasons | @aws-sdk/client-elastic-load-balancing-v2 |
| `cloudtrail(event_name?, resource_name?, ...)` | Recent AWS API events — deploys, config changes | @aws-sdk/client-cloudtrail |
| `asg_activity(asg_name?)` | Auto Scaling group config + scaling history | @aws-sdk/client-auto-scaling |
| `route53_check(domain?, zone_id?)` | Route 53 DNS record lookup | @aws-sdk/client-route-53 |

### Kubernetes Tools

| Tool | What it does | Source |
|------|-------------|-------|
| `k8s_pods(namespace?, selector?)` | Structured pod status: CrashLoop, OOM, restarts, exit codes | kubectl JSON |
| `k8s_events(namespace?, severity?, since?)` | Cluster events with severity filtering | kubectl JSON |
| `k8s_logs(pod, namespace?, grep?, previous?)` | Pod log search with grep, crashed container support | kubectl logs |

### MCP Tools

| Tool | What it does | Transport |
|------|-------------|-----------|
| `mcp_tool(name, ...args)` | Route to any connected AWS MCP server tool | stdio/HTTP |

### MCP Server Catalog (30+ available)

```
Observability : cloudwatch, cloudtrail, prometheus, appsignals
Compute       : ecs, eks, lambda, serverless
Databases     : postgres, mysql, dynamodb, documentdb, redshift
Caching       : elasticache (redis), valkey, memcached
Messaging     : sns, sqs, stepfunctions, msk (kafka), mq
Networking    : network (vpc)
Security      : iam
IaC           : iac
Cost          : cost
```

---

## Flow: `create --engine terraform` (default)

```
User: "create an RDS PostgreSQL instance"
         │
         ▼
  ClarifyAgent.run()                        ← ReAct loop
    LLM asks: "What instance class?"
    LLM asks: "What is the database name?"
    LLM concludes: enriched_instruction + resource_types
         │
         ▼
  TerraformRegistryClient                   ← schemas for detected resource types
         │  ProviderSchema[] (optional — registry may be unavailable)
         ▼
  PlannerAgent.generatePlanFromDescription()
         │  InfraPlan { summary, steps[], terraform.files{} }
         ▼
  print plan summary + risk badges
         │
         ▼
  ┌─ approved? ─┐
  │ no → exit   │ yes
  └─────────────┘
         │
         ▼
  ExecutorAgent.execute()
    ├── materializePlan()  →  tenants/<id>/plans/<planId>/*.tf
    ├── runPlan()          →  terraform init + plan
    └── runApply()         →  terraform apply
```

---

## Flow: `create --engine aws`

```
User: "create an S3 bucket"
         │
         ▼
  ClarifyAgent.run()                        ← ReAct loop, same as above
         │  enrichedInstruction
         ▼
  AwsPlannerAgent.generatePlan(description)
         │  AwsExecutionPlan { calls: [{ typeName, operation, desiredState }] }
         ▼
  print Cloud Control call list
         │
         ▼
  ┌─ approved? ─┐
  │ no → exit   │ yes
  └─────────────┘
         │
         ▼
  AwsExecutorService.execute()  (sequential)
    └── for each CloudControlCall:
          CreateResourceCommand
              │
              ▼
          poll GetResourceRequestStatus
              │
          SUCCESS → next call
          FAILED  → stop
```

---

## Flow: `update --tf-dir <path>` (SRE patch)

```
Existing ./infra/*.tf
         │
         ▼
  TerraformMcpService.readExistingFiles()   ← all .tf / .tfvars
         │
         ▼
  ClarifyAgent.run(instruction, existingFiles)  ← ReAct loop
    LLM sees existing files as context — won't re-ask what's already defined
         │
         ▼
  PlannerAgent.patchExisting(existingFiles, enrichedInstruction)
    ├── Edit existing file if change fits naturally
    ├── Create new file if resource is self-contained
    └── Returns ONLY changed/new files — unchanged files merged automatically
         │
         ▼
  print unified diff per file (git-style, 3 lines of context)
         │
         ▼
  approved? → writeFiles() → terraform plan → approved? → terraform apply
```

---

## Flow: `diagnose`

```
"Why is checkout latency spiking in prod?"
         │
         ▼
  AwsMcpService.connect()                   ← connect cloudwatch, cloudtrail, etc.
         │  Discovers 50+ MCP tools dynamically
         ▼
  DiagnoseAgent.run()                       ← ReAct loop, up to 25 steps
    Step 1:  parallel × 6 (TRIAGE)
               cw_metrics("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", ...)
               cw_metrics("AWS/ApplicationELB", "TargetResponseTime", ...)
               elb_health(load_balancer="checkout-alb")
               cloudtrail(since_hours=3)
               ecs_describe(cluster="prod", service="checkout-api")
               cw_logs("/ecs/checkout-api", "ERROR", since_hours=1)
    ───── Evidence Board: [!!] 417 5XX errors | [!] CHANGE: UpdateService at 10:15 ─────
    Step 2:  ecs_describe(cluster="prod", service="checkout-api")  ← deployment detail
    Step 3:  k8s_events(severity="warning", since="2h")
    Step 4:  cw_metrics("AWS/RDS", "DatabaseConnections", ...)    ← dependency check
    ...
    Done:    { done:true, answer: "## Incident Summary\n## Root Cause\n..." }
         │
         ▼
  renderReport()
    Investigation: 12 tool calls, 8 steps, 14.3s execution time
```

---

## Flow: `ask`

```
"How many EKS clusters in ap-south-1?"
         │
         ▼
  AskAgent.run()                            ← ReAct loop, up to 15 steps
    Step 1:  aws_query("AWS::EKS::Cluster", region="ap-south-1")
    Done:    { thought, done:true, answer: "You have 2 EKS clusters: ..." }
         │
         ▼
  renderReport()

"What is the health of the checkout load balancer?"
         │
         ▼
  AskAgent.run()
    Step 1:  parallel × 2
               elb_health(load_balancer="checkout-alb")
               cw_metrics("AWS/ApplicationELB", "TargetResponseTime", ...)
    Done:    answer with target health + latency values
```

---

## Services Layer

```
┌─────────────────────────────────────────────────────────────────────┐
│  diagnoseTools.ts  (shared by AskAgent, DiagnoseAgent)              │
│  16 tools — LLM picks dynamically at each step                      │
│                                                                     │
│  Core:          run_command · aws_query · aws_get · ec2_exec        │
│  Observability: cw_metrics · cw_logs · pi_top_sql                   │
│  Infrastructure: ecs_describe · elb_health · cloudtrail             │
│                  asg_activity · route53_check                       │
│  Kubernetes:    k8s_pods · k8s_events · k8s_logs                    │
│  MCP:           mcp_tool (routes to 30+ AWS MCP server tools)       │
│                                                                     │
│  Safety: blocklist (rm, fdisk, dd, kubectl delete/apply/patch/scale)│
│  Output: 6-8KB per tool result (scaled for LLM reasoning)           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  AwsMcpService  (src/services/awsMcpService.ts)                     │
│  Multi-server MCP client — connects to awslabs MCP servers          │
│  ├── connect()           → stdio (uvx) or HTTP transport            │
│  ├── discoverTools()     → merges tool catalogs from all servers    │
│  ├── callTool(name, args)→ routes to correct server automatically   │
│  └── 30+ well-known servers with default uvx commands               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  BedrockService  (src/services/bedrockService.ts)                   │
│  LLM: Claude Sonnet 4.5 (Bedrock) — fallback: Mistral Large 3      │
│  Region: ap-south-1 (hardcoded for Bedrock availability)            │
│  Features: retry (3x), fallback model, telemetry, token tracking    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  TerraformMcpService / TerraformRegistryClient                      │
│  ├── readExistingFiles() / writeFiles()                             │
│  ├── materializePlan()                                              │
│  ├── runPlan()   ─── MCP tool or exec fallback                      │
│  └── runApply()  ─── MCP tool or exec fallback                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  AwsExecutorService  (Cloud Control)                                │
│  └── CreateResourceCommand → poll → SUCCESS/FAILED                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Multi-Tenancy & Safety

```
Every command:
  │
  ├── RateLimiterService    → free:15/min · pro:60/min · enterprise:240/min
  ├── SubscriptionService   → free cannot apply · pro/enterprise can
  ├── TracingService        → all logs tagged { traceId, tenantId, command }
  └── TelemetryCollector    → model usage, token counts, latency tracking

Approval gates:
  create  → approval before apply
  update  → approval before write + approval before apply
  apply   → approval before apply

ReAct tool safety (run_command blocklist):
  ├── no destructive shell ops (rm -rf, fdisk, dd)
  ├── no AWS CLI (use SDK tools instead)
  └── no kubectl delete/apply/patch/edit/scale

Credential isolation:
  Bedrock account (LLM calls) ← separate from → Tenant account (infrastructure)
  Cross-account design with explicit credential passing
```

---

## Directory Map

```
src/
├── agents/          clarifyAgent · plannerAgent · awsPlannerAgent
│                    executorAgent · diagnoseAgent · askAgent
├── cli/             index (commands + DI) · interactive · prompts
├── services/        bedrockService · diagnoseTools · awsMcpService
│                    awsExecutorService
│                    terraformMcpService · terraformRegistryClient
│                    tenantService · subscriptionService · rateLimiterService
│                    tracingService · telemetryCollector · resourceTypeRegistry
├── workflows/       infraWorkflow  (all 5 workflow methods)
├── utils/           llm · logging · terminal
└── types.ts

tenants/
└── <tenantId>/plans/<planId>/   ← generated .tf files

docs/
├── architecture.md              ← this file
└── infra-tool-roadmap.md          ← AI SRE platform roadmap
```

---

## Engine Comparison

| | Terraform (default) | AWS (`--engine aws`) |
|---|---|---|
| Plan format | HCL files | Cloud Control JSON |
| Execution | `terraform apply` | `CreateResourceCommand` |
| State tracking | `.tfstate` | AWS resource state |
| Rollback | `terraform destroy` | Manual |
| Best for | Production with drift detection | Fast provisioning |

---

## AWS SDK Dependencies

```
@aws-sdk/client-bedrock-runtime     — LLM (Claude Sonnet 4.5)
@aws-sdk/client-cloudcontrol         — aws_query, aws_get
@aws-sdk/client-cloudwatch           — cw_metrics
@aws-sdk/client-cloudwatch-logs      — cw_logs
@aws-sdk/client-pi                   — pi_top_sql (Performance Insights)
@aws-sdk/client-rds                  — RDS instance lookup for PI
@aws-sdk/client-ecs                  — ecs_describe
@aws-sdk/client-elastic-load-balancing-v2 — elb_health
@aws-sdk/client-cloudtrail           — cloudtrail
@aws-sdk/client-auto-scaling         — asg_activity
@aws-sdk/client-ssm                  — ec2_exec (SSM RunCommand)
@aws-sdk/client-route-53             — route53_check
@aws-sdk/client-sts                  — caller identity
@modelcontextprotocol/sdk            — MCP client (stdio + HTTP)
```
