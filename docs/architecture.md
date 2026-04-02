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

## Agentic Design

All agents follow the same **ReAct loop** pattern (Reason + Act):

```
while not done:
    LLM receives:  system prompt + tool catalog + step history
    LLM returns:   { thought, tool, params }   ← single call
                or { thought, calls: [...] }   ← parallel fan-out
                or { thought, done: true, answer/report/... }
    Tool executes, result appended to history
    History compressed (last 3 full · older summarised)
```

No cases, no pre-wired data sources, no hardcoded field extraction.
The LLM decides at each step what to run and when it has enough information.

---

## Agents

| Agent | Pattern | Responsibility |
|-------|---------|---------------|
| `ClarifyAgent` | ReAct · `ask_user` tool | Interactively gathers requirements before planning. LLM asks ONE question at a time and concludes with an enriched description + resource types. |
| `PlannerAgent` | Single LLM call | Enriched description → Terraform HCL files (create) or file patches (update). Uses LCS unified diff for display. |
| `AwsPlannerAgent` | Single LLM call | Enriched description → Cloud Control API call plan |
| `ExecutorAgent` | Deterministic | Runs `terraform init / plan / apply` via TerraformMcpService |
| `DiagnoseAgent` | ReAct · 6 tools | Single agent for both `debug` and `diagnose` commands. Accepts a question or service name + optional `DebugOptions` (Loki URL, OpenSearch URL, namespace, look-back). LLM decides the full investigation path. |
| `AskAgent` | ReAct · 5 tools | LLM answers AWS inventory / metrics / k8s questions by querying live data. No pre-classification. |

**Shared tool set** (`src/services/diagnoseTools.ts`):

| Tool | What it does |
|------|-------------|
| `run_command(command)` | Any read-only shell cmd: `kubectl`, `helm`, `dig`, `curl` |
| `aws_query(type, ...)` | List AWS resources via Cloud Control SDK |
| `aws_get(type, id, ...)` | Fetch full properties of one AWS resource |
| `ec2_exec(instance_id, cmd)` | Run command inside EC2 via SSM (no SSH needed) |
| `cw_metrics(namespace, metric, ...)` | CloudWatch metric statistics |
| `cw_logs(log_group, ...)` | CloudWatch Logs search |

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
    LLM asks: "What instance type for the node pool?"
    LLM asks: "Spot or on-demand?"
    LLM concludes: enriched_instruction + resource_types
         │
         ▼
  TerraformRegistryClient   ← schemas for new types + existing types
         │
         ▼
  PlannerAgent.patchExisting(existingFiles, enrichedInstruction)
    ├── Edit existing file if change fits naturally (e.g. add node_group to cluster.tf)
    ├── Create new file if resource is self-contained (e.g. node_pool.tf)
    └── Returns ONLY changed/new files — unchanged files merged automatically
         │
         ▼
  print unified diff per file (git-style, 3 lines of context)
    @@ -45,7 +45,13 @@
      capacity_type = "ON_DEMAND"
    + tej = { instance_types = [...] }
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
  DiagnoseAgent.run(serviceName, region, options)  ← ReAct loop, up to 20 steps
    Step 1:  run_command("kubectl get pods -n default")
    Step 2:  parallel × 2
               cw_logs("/ecs/checkout-api", "ERROR", since_hours=1)
               run_command("kubectl describe pod checkout-api-xxx")
    Step 3:  cw_metrics("AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", ...)
    ...
    Done:    { thought, done:true, report: "## Root Cause\n..." }
         │
         ▼
  renderReport()  →  terminal output
    ## Root Cause · ## Fix It Now · ## Prevent Recurrence
```

---

## Flow: `diagnose`

```
"why is mimir crashing?"
         │
         ▼
  DiagnoseAgent.run()                       ← ReAct loop, up to 20 steps
    Step 1:  run_command("kubectl get pods --all-namespaces | grep mimir")
    Step 2:  parallel × 2
               run_command("kubectl describe pod mimir-xxx -n monitoring")
               cw_logs("/aws/eks/cluster", "mimir", since_hours=1)
    Step 3:  aws_query("AWS::EKS::Cluster") → check node group status
    ...
    Done:    { thought, done:true, answer: "## Root Cause\n..." }
         │
         ▼
  renderReport()
```

---

## Flow: `ask`

```
"how many EKS clusters in ap-south-1?"
         │
         ▼
  AskAgent.run()                            ← ReAct loop, up to 15 steps
    Step 1:  aws_query("AWS::EKS::Cluster", region="ap-south-1")
    Done:    { thought, done:true, answer: "You have 2 EKS clusters: ..." }
         │
         ▼
  renderReport()

"what is the CPU usage of my lambda functions?"
         │
         ▼
  AskAgent.run()
    Step 1:  parallel × 3
               cw_metrics("AWS/Lambda", "Duration", ...)
               cw_metrics("AWS/Lambda", "Errors", ...)
               cw_metrics("AWS/Lambda", "Throttles", ...)
    Done:    answer with actual metric values
```

---

## Services Layer

```
┌─────────────────────────────────────────────────────────┐
│  diagnoseTools.ts  (shared by AskAgent, DiagnoseAgent)  │
│  ├── run_command()   shell execution (kubectl/helm/dig) │
│  ├── aws_query()     Cloud Control ListResources        │
│  ├── aws_get()       Cloud Control GetResource          │
│  ├── ec2_exec()      SSM RunCommand on EC2              │
│  ├── cw_metrics()    CloudWatch GetMetricStatistics     │
│  └── cw_logs()       CloudWatch FilterLogEvents         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TerraformMcpService                                    │
│  ├── readExistingFiles() / writeFiles()                 │
│  ├── materializePlan()                                  │
│  ├── runPlan()   ─── MCP tool or exec fallback          │
│  └── runApply()  ─── MCP tool or exec fallback          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TerraformRegistryClient  (MCP client)                  │
│  └── fetchSchemas() → schema injection into planner     │
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

ReAct tool safety (run_command blocklist):
  ├── no destructive shell ops (rm -rf, fdisk, dd)
  ├── no AWS CLI (use SDK tools instead)
  └── no kubectl delete/apply
```

---

## Directory Map

```
src/
├── agents/          clarifyAgent · plannerAgent · awsPlannerAgent
│                    executorAgent · diagnoseAgent · askAgent
├── cli/             index (commands + DI) · interactive · prompts
├── services/        bedrockService · diagnoseTools
│                    awsExecutorService
│                    terraformMcpService · terraformRegistryClient
│                    tenantService · subscriptionService · rateLimiterService
│                    tracingService · telemetryCollector
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
