# InfraForge — Architecture & Flows

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI  (src/cli/index.ts)                                             │
│                                                                      │
│  ask            → simple Q&A about AWS/K8s                          │
│  diagnose       → deep incident investigation                        │
│  plan create    → generate + approve + execute new infrastructure    │
│  plan dry-run   → generate plan, no execution                        │
│  plan apply     → apply change (new input or patch existing TF dir)  │
│                                                                      │
│  Global: --region · --model · --reasoning · --log-level             │
│          --bedrock-* · --aws-* credentials                           │
└───────────────────────┬──────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  InfraWorkflow  (src/workflows/infraWorkflow.ts)                     │
│  Rate limits · subscription checks · tracing · telemetry            │
└──┬───────┬──────────────────────────────────────────────────────────┘
   │       │
   ▼       ▼
ask /   plan create / dry-run / apply
diagnose
```

---

## Three Commands

### `ask` — Inventory Q&A

Simple question answering about live AWS and Kubernetes state. Runs a
ReAct loop of up to 15 steps (quick=5, standard=15, deep=25) using the
shared tool set. No incident methodology — just find and return data.

```
infra ask -q "how many EKS clusters in ap-south-1?"
```

### `diagnose` — Incident Investigation

Deep root cause analysis. Runs a 4-phase investigation (TRIAGE →
CORRELATE → HYPOTHESIZE → ROOT CAUSE) with up to 40 steps. Accepts all
observability sources: CloudWatch, K8s, Loki, OpenSearch. K8s context
is auto-discovered from the current kubectl context if not provided.

```
infra diagnose -q "why is mimir crashing?" --reasoning deep
infra diagnose -q "cert expired?" --namespace prod --k8s-context prod-cluster
```

### `plan` — Infrastructure Management

Three subcommands, each with a `--mode terraform|aws` flag:

| Subcommand | What it does |
|---|---|
| `plan create` | Intent → clarify → plan → approve → execute |
| `plan dry-run` | Intent → clarify → plan → show diff (no apply) |
| `plan apply` | Intent → apply (new) or patch existing `--tf-dir` → apply |

---

## Agentic Design

All agents follow the **ReAct loop** (Reason + Act):

```
while not done:
    LLM receives:  system prompt + tool catalog + evidence board + step history
    LLM returns:   { thought, tool, params }         ← single call
                or { thought, calls: [...] }          ← parallel fan-out (up to 8)
                or { thought, done: true, answer }
    Tool(s) execute (parallel when possible)
    Evidence tracker extracts key findings
    History compressed (last 5 steps full · older → 2 key lines each)
```

---

## Agents

| Agent | Pattern | Responsibility |
|-------|---------|---------------|
| `ClarifyAgent` | ReAct · `ask_user` tool | Gathers requirements interactively before planning. Asks ONE question at a time, concludes with enriched description + resource types. |
| `PlannerAgent` | Single LLM call | Enriched description → Terraform HCL files (create) or file patches (update). |
| `AwsPlannerAgent` | Single LLM call | Enriched description → Cloud Control API call plan. |
| `ExecutorAgent` | Deterministic | Runs `terraform init / plan / apply` via TerraformMcpService. |
| `DiagnoseAgent` | ReAct · 16 tools · evidence board | Senior SRE investigation engine. 4-phase methodology. Step limits: quick=8, standard=25, deep=40. |
| `AskAgent` | ReAct · 16 tools | Answers AWS/K8s inventory questions from live data. Step limits: quick=5, standard=15, deep=25. |

---

## DiagnoseAgent — SRE Investigation Engine

```
"Why is checkout latency spiking?"
         │
         ▼
  Phase 1: TRIAGE (step 1 — parallel fan-out 4-6 calls)
  ┌────────────────────────────────────────────────────────────┐
  │  cw_metrics(5XX)    elb_health(lb)    cloudtrail(3h)      │
  │  cw_metrics(latency) k8s_pods(all-ns)  cw_logs(errors)   │
  └────────────────────────────┬───────────────────────────────┘
                               │
    Evidence Board auto-extracts: errors, deploys, crashes, K8s signals
                               │
         ▼
  Phase 2: CORRELATE (steps 2-5)
  ┌────────────────────────────────────────────────────────────┐
  │  Align timestamps: when did anomaly start?                 │
  │  Cross-reference: deploy time vs first error               │
  │  K8s signals → pivot to scheduling/cert/ingress deep-dive  │
  └────────────────────────────┬───────────────────────────────┘
                               │
         ▼
  Phase 3: HYPOTHESIS (steps 6-12)
  ┌────────────────────────────────────────────────────────────┐
  │  State theory in "thought". Run ONE disproof query.        │
  │  K8s: describe pod/node/ingress/cert as needed.            │
  └────────────────────────────┬───────────────────────────────┘
                               │
         ▼
  Phase 4: ROOT CAUSE (steps 13+)
  ┌────────────────────────────────────────────────────────────┐
  │  ## Incident Summary  (severity · impact · duration)       │
  │  ## Root Cause        (specific component + evidence)      │
  │  ## Evidence Chain    (numbered, timestamped)              │
  │  ## Timeline          (minute-by-minute)                   │
  │  ## Immediate Remediation                                  │
  │  ## Permanent Fix + Prevention                             │
  └────────────────────────────────────────────────────────────┘
```

### K8s Signal Detection & Phase Pivots

When K8s signals are detected in the evidence board, the phase hint
switches the agent to a targeted K8s investigation path:

| Signal type | Trigger pattern | Deep-dive focus |
|---|---|---|
| `K8S_SCHEDULE` | `0/N nodes are available`, `taint`, `unschedulable` | describe pod, node conditions, taints, resourcequota, FailedScheduling events |
| `K8S_STUCK` | `ImagePullBackOff`, `ContainerCreating` | describe pod, pull secrets, PVCs |
| `K8S_NODE` | `MemoryPressure`, `NotReady`, `evict` | describe node, EC2 instance status, top nodes |
| `K8S_QUOTA` | `exceeded quota`, `limitrange` | describe resourcequota, limitrange, top pods |
| `K8S_INGRESS` | `no endpoints available`, `upstream error`, ingress 502/503 | describe ingress, get endpoints, svc selector, ingress controller health |
| `K8S_CERT` | `certificate expired`, `x509`, `acme error`, `challenge failed` | get/describe certificate, certificaterequest, challenge, cert-manager logs |

### Evidence Board

Auto-extracted from every tool result and presented to the LLM at every step:

- **Critical**: 5XX errors, CrashLoop, OOMKilled, unhealthy targets, stopped tasks, K8s scheduling/cert/ingress failures
- **Warning**: Deployments, config changes, scaling events
- **Info**: Metric summaries (max/avg values)

---

## Shared Tool Set (`src/services/diagnoseTools.ts`)

### Core Tools

| Tool | What it does |
|------|-------------|
| `run_command(command)` | Any read-only shell cmd: `kubectl describe`, `dig`, `curl`, `nc` |
| `aws_query(type, ...)` | List AWS resources via Cloud Control SDK |
| `aws_get(type, id, ...)` | Fetch full properties of one AWS resource |
| `ec2_exec(instance_id, cmd)` | Run command inside EC2 via SSM (no SSH needed) |
| `aws_cli(command)` | Read-only AWS CLI commands (credentials auto-injected) |

### AWS Observability

| Tool | What it does |
|------|-------------|
| `cw_metrics(namespace, metric, ...)` | CloudWatch metric statistics (any unit) |
| `cw_logs(log_group, ...)` | CloudWatch Logs search |
| `pi_top_sql(instance, ...)` | Performance Insights — top SQL by DB load |

### AWS Infrastructure

| Tool | What it does |
|------|-------------|
| `ecs_describe(cluster?, service?, task_id?)` | ECS clusters → services → tasks with events, stopped reasons |
| `elb_health(load_balancer?, target_group?)` | ALB/NLB target group health |
| `cloudtrail(event_name?, resource_name?, ...)` | Recent AWS API events — deploys, config changes |
| `asg_activity(asg_name?)` | Auto Scaling group config + scaling history |
| `route53_check(domain?, zone_id?)` | Route 53 DNS record lookup |

### Kubernetes

| Tool | What it does |
|------|-------------|
| `k8s_pods(namespace?, selector?)` | Structured pod status: CrashLoop, OOM, restarts, exit codes |
| `k8s_events(namespace?, severity?, since?)` | Cluster events with severity filtering |
| `k8s_logs(pod, namespace?, grep?, previous?)` | Pod log search with grep, crashed container support |

K8s context is auto-discovered from `kubectl config current-context` when `--k8s-context` is not provided.

### MCP

| Tool | What it does |
|------|-------------|
| `mcp_tool(name, ...args)` | Route to any connected AWS MCP server tool |

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

## Flow: `plan create --mode terraform`

```
User: "create an RDS PostgreSQL instance"
         │
         ▼
  ClarifyAgent.run()                         ← ReAct loop
    LLM asks: "What instance class?"
    LLM concludes: enriched_instruction + resource_types
         │
         ▼
  TerraformRegistryClient                    ← schemas for resource types
         │
         ▼
  PlannerAgent.generatePlanFromDescription()
         │  InfraPlan { summary, steps[], terraform.files{} }
         ▼
  print plan summary + diff
         │
  ┌─ approved? ─┐
  │ no → exit   │ yes → ExecutorAgent → terraform init + plan + apply
  └─────────────┘
```

## Flow: `plan create --mode aws`

```
User: "create an S3 bucket"
         │
  ClarifyAgent.run()
         │
  AwsPlannerAgent.generatePlan()
         │  AwsExecutionPlan { calls: [{ typeName, operation, desiredState }] }
         ▼
  ┌─ approved? ─┐
  │ no → exit   │ yes → CreateResourceCommand → poll → SUCCESS/FAILED
  └─────────────┘
```

## Flow: `plan apply --tf-dir <path>`

```
Existing ./infra/*.tf
         │
  TerraformMcpService.readExistingFiles()
         │
  ClarifyAgent.run(instruction, existingFiles)
         │
  PlannerAgent.patchExisting()
    └── returns ONLY changed/new files
         │
  print unified diff
         │
  approved? → writeFiles() → terraform plan → approved? → terraform apply
```

## Flow: `diagnose`

```
"Why is mimir not starting?"
         │
  AwsMcpService.connect()         ← connects cloudwatch, cloudtrail, etc.
         │
  runPreflight()
    ├── AWS: sts get-caller-identity
    └── K8s: kubectl config current-context → kubectl cluster-info (auto-discover)
         │
  DiagnoseAgent.run()             ← ReAct loop, up to 40 steps (--reasoning deep)
    Step 1:  parallel × 4 (TRIAGE)
               k8s_pods(namespace=mimir)
               k8s_events(namespace=all, severity=warning)
               cloudtrail(since_hours=3)
               cw_logs(...)
    ─── Evidence Board: [!!] K8S_SCHEDULE: 0/8 nodes are available ───
    → Phase pivots to K8S SCHEDULING DEEP-DIVE
    Step 2:  parallel × 5
               kubectl describe pod <pod>
               kubectl get nodes -o wide
               kubectl describe nodes | grep Conditions/Taints/Allocatable
               kubectl get resourcequota --all-namespaces
               kubectl get events --field-selector reason=FailedScheduling
    Done:    ## Root Cause: nodes have NoSchedule taint, pods missing toleration
```

## Flow: `ask`

```
"How many EKS clusters?"
         │
  AskAgent.run()                  ← ReAct loop, up to 15 steps (standard)
    Step 1:  aws_query("AWS::EKS::Cluster")
    Done:    "You have 2 EKS clusters: ..."
```

---

## Services Layer

```
diagnoseTools.ts   shared by AskAgent + DiagnoseAgent
  Core:          run_command · aws_query · aws_get · ec2_exec · aws_cli
  Observability: cw_metrics · cw_logs · pi_top_sql
  Infrastructure: ecs_describe · elb_health · cloudtrail · asg_activity · route53_check
  Kubernetes:    k8s_pods · k8s_events · k8s_logs  (context auto-discovered)
  MCP:           mcp_tool (routes to 30+ AWS MCP server tools)
  Safety:        blocklist — rm, fdisk, dd, kubectl delete/apply/patch/edit/scale

BedrockService
  Model:   Claude Sonnet 4.5 via Bedrock (--model to override)
  Fallback: Mistral Large 3 if Anthropic access blocked
  Features: retry (3×), telemetry, token tracking

AwsMcpService
  Multi-server MCP client — stdio (uvx) or HTTP transport
  discoverTools() merges catalogs from all connected servers

TerraformMcpService / TerraformRegistryClient
  readExistingFiles / writeFiles / materializePlan / runPlan / runApply
```

---

## Reasoning Depth

| Flag | `ask` steps | `diagnose` steps | Use case |
|---|---|---|---|
| `--reasoning quick` | 5 | 8 | Fast inventory checks, known simple issues |
| `--reasoning standard` | 15 | 25 | Default — most incidents |
| `--reasoning deep` | 25 | 40 | Complex multi-service failures, cert/ingress issues |

---

## Multi-Tenancy & Safety

```
Every command:
  ├── RateLimiterService    → free:15/min · pro:60/min · enterprise:240/min
  ├── SubscriptionService   → free cannot apply · pro/enterprise can
  ├── TracingService        → all logs tagged { traceId, tenantId, command }
  └── TelemetryCollector    → model usage, token counts, latency tracking

Approval gates (plan commands only):
  create  → approval before apply
  apply   → approval before write + approval before apply

ReAct tool safety:
  ├── no destructive shell ops (rm -rf, fdisk, dd)
  ├── kubectl delete/apply/patch/edit/scale blocked
  └── aws_cli: only read-only subcommands (describe, list, get, query...)

Credential isolation:
  Bedrock account (LLM) ← separate from → Tenant account (infrastructure)
```

---

## Directory Map

```
src/
├── agents/       clarifyAgent · plannerAgent · awsPlannerAgent
│                 executorAgent · diagnoseAgent · askAgent
├── cli/          index (3 commands + DI) · interactive · prompts
├── services/     bedrockService · diagnoseTools · awsMcpService
│                 terraformMcpService · terraformRegistryClient
│                 tenantService · subscriptionService · rateLimiterService
│                 tracingService · telemetryCollector · resourceTypeRegistry
├── workflows/    infraWorkflow
├── utils/        logging · terminal · preflight · serviceRouter · serviceCatalogs
└── types.ts

docs/
├── architecture.md           ← this file
└── infra-tool-roadmap.md     ← AI SRE platform roadmap
```

---

## AWS SDK Dependencies

```
@aws-sdk/client-bedrock-runtime          — LLM (Claude Sonnet 4.5)
@aws-sdk/client-cloudcontrol            — aws_query, aws_get
@aws-sdk/client-cloudwatch              — cw_metrics
@aws-sdk/client-cloudwatch-logs         — cw_logs
@aws-sdk/client-pi                      — pi_top_sql (Performance Insights)
@aws-sdk/client-rds                     — RDS instance lookup for PI
@aws-sdk/client-ecs                     — ecs_describe
@aws-sdk/client-elastic-load-balancing-v2 — elb_health
@aws-sdk/client-cloudtrail              — cloudtrail
@aws-sdk/client-auto-scaling            — asg_activity
@aws-sdk/client-ssm                     — ec2_exec (SSM RunCommand)
@aws-sdk/client-route-53                — route53_check
@aws-sdk/client-sts                     — preflight caller identity check
@modelcontextprotocol/sdk               — MCP client (stdio + HTTP)
```
