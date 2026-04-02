# infra-copilot — Architecture & Flows

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│  CLI  (src/cli/index.ts)                                     │
│  create · plan · apply · update · ask · debug · diagnose     │
│  Global: --tenant-id · --region · --engine · --tf-dir        │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│  InfraWorkflow  (src/workflows/infraWorkflow.ts)             │
│  Rate limits · subscription checks · tracing                 │
└──┬───────┬───────┬───────┬───────┬───────────────────────────┘
   │       │       │       │       │
   ▼       ▼       ▼       ▼       ▼
 create  create  update  debug  ask /
  (tf)  (aws)   (patch)        diagnose
```

---

## Agents

| Agent | Responsibility |
|-------|---------------|
| `IntentAgent` | Natural language → structured `Intent` JSON |
| `PlannerAgent` | Intent → Terraform HCL files (create) or file patches (update) |
| `AwsPlannerAgent` | Intent → Cloud Control API call plan |
| `ExecutorAgent` | Runs `terraform init / plan / apply` via TerraformMcpService |
| `DebuggerAgent` | Aggregates signals from all providers → LLM root cause report |
| `DiagnoseAgent` | Auto-discovers service → parallel signal collection → LLM triage |
| `AskAgent` | Plans + answers AWS inventory / metrics / k8s questions |

---

## Flow: `create --engine terraform` (default)

```
User: "create an RDS PostgreSQL instance in ap-south-1"
         │
         ▼
  IntentAgent.parse()
         │  Intent { action:create, resourceTypes:[aws_db_instance,...], region }
         ▼
  suggestClarificationQuestions()  ──► prompt user for missing params
         │
         ▼
  TerraformRegistryClient          ──► MCP server: resolveProviderDocPage
         │  provider schemas (arg reference)
         ▼
  PlannerAgent.generatePlan()
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
  IntentAgent.parse()
         │
         ▼
  AwsPlannerAgent.generatePlan()
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
Existing ./infra/rds/*.tf
         │
         ▼
  TerraformMcpService.readExistingFiles()   ← all .tf / .tfvars
         │
         ▼
  detectResourceTypes()                     ← regex: resource "aws_*"
         │
         ▼
  TerraformRegistryClient                   ← schemas for detected types
         │
         ▼
  PlannerAgent.patchExisting()
         │  returns ONLY changed/new files
         │  merges with existing (unchanged files kept as-is)
         ▼
  print file diff  (red = removed, green = added)
         │
         ▼
  approved? → writeFiles() → terraform plan → approved? → terraform apply
```

---

## Flow: `debug`

```
--service checkout-api
         │
         ▼
  DebugAggregator.collect()  (parallel)
    ├── CloudWatchLogsProvider    → FilterLogEvents
    ├── CloudWatchMetricsProvider → GetMetricData
    ├── LokiProvider              → HTTP /query_range
    ├── OpenSearchProvider        → search API
    └── K8sProvider               → kubectl logs + events
         │
         ▼
  DebuggerAgent.analyze()
    └── BedrockService.complete() → structured RCA report:
          Root Cause · Evidence · Mitigations · Impact
```

---

## Flow: `diagnose`

```
"why is mimir crashing?"
         │
         ▼
  DiagnoseAgent.parseQuestion()
         │  { serviceName, problem, urgency, lookBack }
         ▼
  ServiceDiscovery.discover()  (parallel)
    ├── kubectl get pods --all-namespaces
    └── CloudWatchService.discoverLogGroups()
         │
         ▼
  parallel signal collection:
    ├── DebugAggregator.collect()     (all debug providers)
    ├── K8sInventoryService.query()   (pods, events, deployments)
    └── AwsMetricsService.query()     (problem-specific metrics)
         │
         ▼
  DiagnoseAgent LLM prompt → structured report:
    ## Direct Answer  /  ## Root Cause  /  ## Fix Now  /  ## Fix Properly  /  ## Impact
```

---

## Flow: `ask`

```
"how many EKS clusters in ap-south-1?"
         │
         ▼
  AskAgent.plan()
         │  AskPlan { targets:["eks"], questionType:"count", region }
         ▼
  parallel data collection:
    ├── AwsInventoryService.collect()   (Cloud Control + STS)
    ├── AwsMetricsService.query()       (if metricsQuery present)
    └── K8sInventoryService.query()     (if k8sQuery present)
         │
         ▼
  AskAgent.answer()  →  BedrockService  →  plain-English answer
```

---

## Services Layer

```
┌─────────────────────────────────────────────────────────┐
│  CloudWatchService  (unified gateway)                   │
│  ├── queryMetrics()  →  GetMetricData (single batch)    │
│  ├── queryLogs()     →  FilterLogEvents                 │
│  └── discoverLogGroups()                                │
│       ▲                ▲                                │
│  AwsMetricsService  CloudWatchLogsProvider              │
│  CloudWatchMetricsProvider   ServiceDiscovery           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TerraformMcpService                                    │
│  ├── readExistingFiles() / writeFiles()                 │
│  ├── materializePlan()                                  │
│  ├── runPlan()   ─── MCP tool "terraform_plan"          │
│  │                └─ exec fallback                      │
│  └── runApply()  ─── MCP tool "terraform_apply"         │
│                  └─ exec fallback                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TerraformRegistryClient  (MCP client)                  │
│  └── resolveProviderDocPage → schema injection          │
│  Transport: stdio (terraform-mcp-server binary)         │
│         or  HTTP  (TERRAFORM_MCP_URL=...)               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  AwsExecutorService  (Cloud Control)                    │
│  └── CreateResourceCommand → poll → SUCCESS/FAILED      │
└─────────────────────────────────────────────────────────┘
```

---

## Multi-Tenancy & Safety

```
Every command:
  │
  ├── RateLimiterService    → free:15/min · pro:60/min · enterprise:240/min
  ├── SubscriptionService   → free cannot apply · pro/enterprise can
  └── TracingService        → all logs tagged { traceId, tenantId, command }

Approval gates:
  create  → approval before apply
  update  → approval before write + approval before apply
  apply   → approval before apply
```

---

## Directory Map

```
src/
├── agents/          intentAgent · plannerAgent · awsPlannerAgent
│                    executorAgent · debuggerAgent · diagnoseAgent · askAgent
├── cli/             index (commands + DI) · interactive · prompts
├── services/        bedrockService · cloudWatchService · awsMetricsService
│                    awsExecutorService · awsInventoryService · k8sInventoryService
│                    terraformMcpService · terraformRegistryClient
│                    tenantService · subscriptionService · rateLimiterService
│                    serviceDiscovery · tracingService
├── providers/       IDebugProvider · debugAggregator
│                    cloudWatchLogsProvider · cloudWatchMetricsProvider
│                    lokiProvider · openSearchProvider · k8sProvider
├── workflows/       infraWorkflow  (all 5 workflow methods)
├── utils/           llm · logging · terminal
└── types.ts

tenants/
└── <tenantId>/plans/<planId>/   ← generated .tf files
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
