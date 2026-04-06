# InfraForge — AI SRE Platform Roadmap

## Current State (as of April 2026)

### What Works
- 16 diagnostic tools (run_command, aws_query, aws_get, ec2_exec, cw_metrics, cw_logs, pi_top_sql, ecs_describe, elb_health, cloudtrail, asg_activity, route53_check, k8s_pods, k8s_events, k8s_logs, mcp_tool)
- 30+ MCP server integrations (cloudwatch, cloudtrail, ecs, eks, rds, etc.)
- Senior SRE investigation engine with 4-phase methodology
- Evidence board auto-extraction (errors, deploys, crashes, metrics)
- Incident pattern recognition (deploy, resource exhaustion, dependency, traffic, single-host)
- Parallel fan-out (up to 8 concurrent tool calls)
- Truncation auto-retry for conclusions
- Claude Sonnet 4.5 via Bedrock with Mistral fallback

### What's Missing

| Capability | Current | Target | Gap |
|---|---|---|---|
| Interface | CLI only | Slack bot | No Slack integration |
| Memory / Patterns | None | Persistent knowledge store with semantic search | No persistent knowledge |
| Integrations | 16 SDK + 30 MCP | 50+ | Missing: Datadog, Jira, GitHub, PagerDuty |
| Workflow automation | Read-only diagnosis | End-to-end: diagnose → ticket → PR | No write actions |
| Multi-service | Single-service focus | Cross-service, cross-cluster | Limited correlation |
| Proactive | None | Alert-driven auto-investigation | Reactive only |
| Feedback loop | None | Self-improving via feedback | No learning mechanism |

---

## Phase 1: Core Quality (CURRENT — In Progress)

**Goal**: Make every investigation produce accurate, actionable results.

### Completed
- [x] Fix cw_metrics Unit:Percent bug (was filtering out non-% metrics)
- [x] Fix ec2_exec to use SSM SDK (removed AWS CLI dependency)
- [x] Add ECS tools (describe clusters/services/tasks/deployments)
- [x] Add ELB target health tool
- [x] Add CloudTrail lookup tool
- [x] Add Auto Scaling events tool
- [x] Add Route53 DNS tool
- [x] Add structured K8s tools (k8s_pods, k8s_events, k8s_logs)
- [x] Fix response truncation (maxTokens 2048→3072/4096, auto-retry)
- [x] Evidence board auto-extraction
- [x] Incident pattern recognition in prompts
- [x] SRE decision framework (cause vs symptom, anti-patterns)
- [x] Improve history compression (5 recent steps, 2 key lines for older)

### Remaining
- [ ] Add Datadog integration (metrics, monitors, APM traces)
- [ ] Add S3 access log analysis tool
- [ ] Add VPC Flow Log analysis tool
- [ ] Add Lambda invocation and error analysis tool
- [ ] Add RDS/Aurora event subscription lookup
- [ ] Add Security Group analysis (inbound/outbound rule check)
- [ ] Improve error message quality when tools fail
- [ ] Add cost analysis tool (Cost Explorer SDK)
- [ ] Validate with 20+ real incident scenarios

---

## Phase 2: Memory & Pattern Store

**Goal**: System gets smarter with every investigation. Stores patterns, service maps, and incident history so it can search and match against past knowledge.

### What We Need to Store

```
┌─────────────────────────────────────────────────────────────────────┐
│  MEMORY TYPES                                                       │
│                                                                     │
│  1. SERVICE_MAP  (structured — exact lookup)                        │
│     service name → cluster, namespace, ALB, target group,           │
│                    RDS instance, log groups, owner team              │
│     Query: "What infra does checkout-api use?"                      │
│     Access: key-value lookup by service name                        │
│                                                                     │
│  2. INCIDENT_HISTORY  (structured + searchable)                     │
│     incident_id, service, timestamp, severity, root_cause,          │
│     resolution, duration, tools_used, evidence_chain                │
│     Query: "Last 5 incidents for checkout-api"                      │
│     Access: filter by service + time range + severity               │
│                                                                     │
│  3. PATTERN  (semantic search — the hard part)                      │
│     failure_signature: "5XX spike + recent deploy + unhealthy TG"   │
│     root_cause_category: "bad deployment"                           │
│     detection_heuristic: "check cloudtrail → ecs_describe → ..."   │
│     resolution_template: "rollback to previous task def"            │
│     Query: "Current signals look like [5XX, CPU spike, OOM]"        │
│     Access: SEMANTIC SIMILARITY search against stored patterns      │
│                                                                     │
│  4. RUNBOOK  (semantic search)                                      │
│     trigger: "CrashLoopBackOff in ECS"                              │
│     steps: ordered list of diagnostic + remediation steps           │
│     Query: "Known fix for OOMKilled pods?"                          │
│     Access: semantic search by symptom description                  │
│                                                                     │
│  5. OWNERSHIP  (structured)                                         │
│     service → team → on-call rotation → Slack channel               │
│     Query: "Who owns payments-api?"                                 │
│     Access: key-value lookup                                        │
│                                                                     │
│  6. FEEDBACK  (append-only log)                                     │
│     investigation_id, user_rating, correction, learned_fact         │
│     Query: "Was my last diagnosis correct?"                         │
│     Access: append on feedback, scan for training improvements      │
└─────────────────────────────────────────────────────────────────────┘
```

### Search Requirements Analysis

| Data Type | Query Pattern | Search Type Needed |
|---|---|---|
| SERVICE_MAP | "What ALB does X use?" | Exact key lookup |
| INCIDENT_HISTORY | "Incidents for X in last 7 days" | Structured filter (service + time + severity) |
| PATTERN | "Current symptoms match which past pattern?" | **Semantic similarity** (vector search) |
| RUNBOOK | "Known fix for this type of failure?" | **Semantic similarity** + keyword match |
| OWNERSHIP | "Who owns X?" | Exact key lookup |
| FEEDBACK | "All feedback for investigations" | Scan / time-range filter |

**Key insight**: SERVICE_MAP, INCIDENT_HISTORY, OWNERSHIP, FEEDBACK are structured data (exact matches, filters, ranges). PATTERN and RUNBOOK need **semantic search** — "this set of symptoms is similar to that past incident" is not an exact string match, it's meaning-based.

### Database Evaluation

#### Option A: PostgreSQL (Aurora) + pgvector
```
PostgreSQL handles BOTH structured + semantic in one DB:

  Structured:  standard SQL queries, indexes, JSON columns
  Semantic:    pgvector extension — store embeddings, cosine similarity search
  Full-text:   built-in tsvector/tsquery for keyword search

  Embedding flow:
    incident signals → Bedrock Titan Embeddings → 1536-dim vector → pgvector column
    at triage time → embed current signals → cosine similarity against stored patterns
```
| Pro | Con |
|---|---|
| Single DB for everything | Need to manage Aurora instance |
| pgvector is mature, widely used | Embedding generation adds latency (~100ms) |
| SQL for complex queries (joins, aggregations) | Not serverless (Aurora Serverless v2 helps) |
| JSON columns for flexible schema | Need to tune vector index (ivfflat vs hnsw) |
| Full-text search built in | |
| Teams already know PostgreSQL | |

**Best for**: Production system with complex query patterns.

#### Option B: DynamoDB + OpenSearch Serverless
```
DynamoDB for structured, OpenSearch for semantic:

  DynamoDB:    SERVICE_MAP (PK=service_name), INCIDENT_HISTORY (PK=service, SK=timestamp),
               OWNERSHIP (PK=service), FEEDBACK (PK=investigation_id)
  OpenSearch:  PATTERN and RUNBOOK with k-NN vector search + full-text

  Embedding flow:
    signals → Bedrock Titan Embeddings → vector → OpenSearch k-NN index
    triage → embed current signals → k-NN search → top 3 matching patterns
```
| Pro | Con |
|---|---|
| Fully managed, scales to zero (DynamoDB) | Two databases to manage |
| OpenSearch k-NN is powerful | OpenSearch Serverless has cold-start latency |
| Pay-per-request pricing (DynamoDB) | OpenSearch Serverless not cheap ($0.24/OCU/hr) |
| DynamoDB single-digit ms reads | DynamoDB query patterns must be designed upfront |
| Streams for change events | |

**Best for**: Scale-to-zero serverless architecture.

#### Option C: SQLite + Local Embeddings (MVP)
```
Zero infrastructure — everything local:

  SQLite:    all structured data in tables
  sqlite-vss: vector search extension (or just brute-force cosine for <1000 patterns)
  Embeddings: Bedrock Titan or local model (e.g. all-MiniLM-L6-v2)

  At <1000 patterns, brute-force cosine similarity is fast enough (<10ms).
  No need for vector index until scale.
```
| Pro | Con |
|---|---|
| Zero infra, zero cost | Not shared across users (local file) |
| Instant startup | SQLite locks on concurrent writes |
| Perfect for CLI MVP | No replication or backup |
| Can migrate to Postgres later | sqlite-vss is newer/less tested |
| Embeds in the binary | |

**Best for**: MVP / CLI-first development. Migrate to Aurora when Slack bot ships.

#### Option D: Redis (ElastiCache) + Vector Search
```
Redis 7+ with vector search module:

  Structured:  Redis hashes for service maps, sorted sets for incident timelines
  Semantic:    RediSearch vector similarity (FLAT or HNSW index)
  Fast:        sub-millisecond reads, great for triage hot path
```
| Pro | Con |
|---|---|
| Sub-ms reads (fastest option) | Volatile — needs persistence config |
| Vector search built in (Redis 7+) | Memory-bound cost ($$$) |
| Good for hot-path triage | Complex query patterns harder than SQL |
| ElastiCache managed | Not great for historical analysis (large scans) |

**Best for**: Hot cache layer on top of a primary store.

### Recommended Architecture

```
Phase 2 MVP (CLI):
  SQLite + brute-force cosine similarity
  Embeddings: Bedrock Titan Embeddings v2 (1024-dim)
  Storage: ~/.infraforge/memory.db
  Schema: see below

Phase 2→3 (Slack bot, multi-user):
  Migrate to Aurora PostgreSQL + pgvector
  Same schema, same embedding model
  Add connection pooling (RDS Proxy)

Optional hot cache:
  ElastiCache (Redis 7) for service map lookups during triage
  Populate from Aurora, TTL 1 hour
```

### Database Schema (works for both SQLite and PostgreSQL)

```sql
-- Service infrastructure mapping
CREATE TABLE service_map (
  service_name    TEXT PRIMARY KEY,
  cluster         TEXT,          -- ECS cluster or EKS cluster name
  namespace       TEXT,          -- K8s namespace (null for ECS)
  load_balancer   TEXT,          -- ALB/NLB name
  target_group    TEXT,          -- target group name/ARN
  rds_instance    TEXT,          -- RDS instance identifier
  log_groups      TEXT[],        -- CloudWatch log group names (JSON array in SQLite)
  owner_team      TEXT,
  slack_channel   TEXT,
  aws_region      TEXT,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Incident history (one row per completed investigation)
CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,   -- UUID
  service_name    TEXT NOT NULL,
  severity        TEXT NOT NULL,      -- P1, P2, P3
  root_cause      TEXT NOT NULL,      -- one-line root cause
  root_cause_category TEXT,           -- deployment, resource_exhaustion, dependency, traffic, config_change
  resolution      TEXT,               -- what fixed it
  evidence_chain  TEXT,               -- JSON array of evidence items
  tools_used      TEXT,               -- JSON array of tool names
  tool_call_count INTEGER,
  duration_ms     INTEGER,            -- investigation wall time
  started_at      TIMESTAMP NOT NULL,
  resolved_at     TIMESTAMP,
  embedding       VECTOR(1024),       -- pgvector; BLOB in SQLite
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_incidents_service ON incidents(service_name, started_at DESC);

-- Reusable failure patterns (learned from incidents + manually curated)
CREATE TABLE patterns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,      -- "deploy-caused-5xx", "oom-crashloop", "db-connection-exhaustion"
  failure_signature TEXT NOT NULL,    -- human-readable: "5XX spike + recent deploy + unhealthy targets"
  signals         TEXT NOT NULL,      -- JSON array: ["5xx_spike", "recent_deploy", "unhealthy_targets"]
  root_cause_template TEXT,           -- "New deployment {deploy_id} introduced a regression..."
  detection_steps TEXT,               -- JSON: ordered tool calls to confirm this pattern
  resolution_steps TEXT,              -- JSON: ordered remediation actions
  confidence_score REAL DEFAULT 0.5,  -- 0-1, increases with successful matches
  match_count     INTEGER DEFAULT 0,  -- times this pattern was confirmed
  embedding       VECTOR(1024),       -- semantic embedding of failure_signature + signals
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Runbooks (known procedures for specific failure types)
CREATE TABLE runbooks (
  id              TEXT PRIMARY KEY,
  trigger         TEXT NOT NULL,      -- "CrashLoopBackOff in ECS", "RDS connection limit reached"
  steps           TEXT NOT NULL,      -- JSON array of ordered steps
  automation_level TEXT DEFAULT 'manual',  -- manual, semi-auto, full-auto
  tags            TEXT,               -- JSON array: ["ecs", "crashloop", "oom"]
  embedding       VECTOR(1024),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ownership mapping
CREATE TABLE ownership (
  service_name    TEXT PRIMARY KEY,
  team            TEXT NOT NULL,
  oncall_rotation TEXT,               -- PagerDuty schedule ID or team name
  slack_channel   TEXT,
  escalation_path TEXT,               -- JSON: ordered list of contacts
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Investigation feedback (append-only)
CREATE TABLE feedback (
  id              TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  rating          TEXT,               -- thumbs_up, thumbs_down, partial
  correction      TEXT,               -- "actual root cause was X not Y"
  learned_fact    TEXT,               -- "service X depends on service Y"
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Pattern Matching Flow (during investigation triage)

```
Step 1: Extract current signals from triage results
  Evidence board findings → signal array
  Example: ["5xx_spike", "recent_deploy", "unhealthy_targets", "cpu_normal"]

Step 2: Generate embedding of current signals
  signals + question text → Bedrock Titan Embeddings → 1024-dim vector

Step 3: Search patterns table
  SELECT name, failure_signature, detection_steps, resolution_steps,
         confidence_score, 1 - (embedding <=> $query_embedding) AS similarity
  FROM patterns
  WHERE 1 - (embedding <=> $query_embedding) > 0.7   -- similarity threshold
  ORDER BY similarity DESC
  LIMIT 3;

Step 4: Inject matched patterns into LLM prompt
  "MATCHED PATTERNS from past incidents:
   1. [92% match] deploy-caused-5xx — 5XX spike + recent deploy + unhealthy targets
      Detection: cloudtrail → ecs_describe → compare deploy timestamp
      Resolution: rollback to previous task definition
   2. [78% match] ..."

Step 5: LLM uses patterns to skip investigation steps
  Instead of discovering the deploy correlation from scratch,
  it immediately checks cloudtrail and confirms the pattern.
```

### Learning Loop (post-investigation)

```
Investigation completes → root cause found
    │
    ├── Extract signals (from evidence board)
    ├── Generate embedding
    ├── Store in incidents table
    │
    ├── Match against existing patterns
    │     ├── Match found → increment match_count, boost confidence_score
    │     └── No match   → create new pattern candidate (confidence=0.3)
    │
    ├── Update service_map (if new infra discovered)
    │     e.g., "checkout-api uses ALB checkout-alb" → upsert service_map
    │
    └── Wait for feedback
          ├── thumbs_up   → boost pattern confidence to min(1.0, +0.1)
          ├── thumbs_down → reduce confidence, store correction
          └── correction   → create/update pattern with correct root cause
```

### Implementation Plan

- [ ] Choose embedding model (Bedrock Titan Embeddings v2 vs Cohere)
- [ ] Implement SQLite memory store (`src/services/memoryStore.ts`)
- [ ] Schema migration on first run (auto-create tables)
- [ ] Service map auto-population from investigation tool results
- [ ] Embedding generation for incidents and patterns
- [ ] Pattern matching query during triage (inject into system prompt)
- [ ] Post-investigation learning loop (store incident + update patterns)
- [ ] Seed initial patterns from common incident types:
  - deploy-caused-5xx
  - oom-crashloop
  - db-connection-exhaustion
  - dns-resolution-failure
  - certificate-expiry
  - scaling-target-mismatch
  - config-change-regression
  - dependency-timeout
  - traffic-spike-overload
  - single-az-failure
- [ ] CLI commands: `infra memory show`, `infra memory search <query>`, `infra memory add-pattern`
- [ ] Migration path to Aurora PostgreSQL + pgvector

### Expected Impact
- Skip 3-5 tool calls per investigation (service map already known)
- Pattern-matched investigations 2x faster (skip discovery phase)
- "What happened last time?" answers in <1 second
- Confidence scores surface most reliable patterns first

---

## Phase 3: Slack Integration

**Goal**: Meet engineers where they work. Thread-based conversations in Slack.

### Architecture
```
Slack Events API
    │
    ▼
Slack Bot Service (new)
    ├── Message handler (thread-aware)
    ├── Conversation state manager
    ├── Permission/channel allowlist
    └── Rate limiting per user/channel
    │
    ▼
DiagnoseAgent / AskAgent (existing)
    │
    ▼
Slack message formatter (markdown → Slack blocks)
```

### Implementation Plan
- [ ] Slack app creation (bot token, event subscriptions)
- [ ] Message handler with thread-based conversation tracking
- [ ] Slack Block Kit formatter for investigation results
- [ ] Channel-based permission model
- [ ] Conversation context preservation across messages in thread
- [ ] File/image attachment support (for metric screenshots)
- [ ] Reaction-based feedback (thumbs up/down → memory store)

### Deployment Options
- Option A: Lambda + API Gateway (serverless, scales to 0)
- Option B: ECS Fargate service (persistent, lower latency)
- Option C: EC2 with socket mode (simplest for MVP)

---

## Phase 4: Workflow Automation

**Goal**: Go from "here's the root cause" to "here's the fix, deployed."

### Integration Plan
- [ ] Jira: create/update tickets from investigation findings
- [ ] GitHub: search code, create PRs with fixes
- [ ] PagerDuty: pull alert context, acknowledge/resolve incidents
- [ ] Terraform: suggest and apply infrastructure changes
- [ ] Kubernetes: safe write operations (scale, restart, rollback)

### End-to-End Flow
```
Alert fires → auto-investigate → finds root cause
    → creates Jira ticket with evidence
    → raises PR with fix (if code change)
    → or applies config change (if infra change)
    → notifies team in Slack with summary
```

### Safety Model
- Read operations: always allowed
- Write operations: require explicit approval
- Destructive operations: blocked by default, require admin override
- Audit trail: every action logged with who approved and why

---

## Phase 5: Proactive Detection

**Goal**: Detect issues before engineers notice them.

### Approach
- [ ] Monitor CloudWatch alarms → auto-triage when alarm fires
- [ ] Monitor PagerDuty alerts → auto-investigate with context
- [ ] Anomaly detection on key metrics (p99 latency, error rates, connection counts)
- [ ] Scheduled health checks for critical services
- [ ] Drift detection: alert when infrastructure deviates from expected state

### Architecture
```
CloudWatch Alarm → SNS → Lambda → DiagnoseAgent
PagerDuty Webhook → API Gateway → DiagnoseAgent
Cron (every 5 min) → Health Check Agent → alert if degraded
```

---

## Phase 6: Multi-Service Correlation

**Goal**: Investigate across service boundaries like a Staff+ SRE.

### Capabilities
- [ ] Service dependency graph (auto-built from traces, logs, network flow)
- [ ] Cascading investigation: if service A is slow, auto-check its dependencies
- [ ] Cross-cluster investigation (multiple EKS clusters, multiple regions)
- [ ] Distributed tracing integration (X-Ray, Datadog APM)
- [ ] Cost impact correlation (performance issue → cost spike)

---

## Success Metrics

| Metric | Current | Target (3 months) |
|---|---|---|
| Tool executions / investigation | ~10 | 20-30 |
| Investigation accuracy | Unknown | >80% |
| Time to root cause | 5-15 min | 2-5 min |
| Integrations | 16 + 30 MCP | 50+ |
| Engineers using daily | 1 (CLI) | 10+ (Slack) |
| Investigations / day | ~5 | 50+ |
| Memory facts | 0 | 200+ |
| Pattern match rate | 0% | >50% of investigations match a known pattern |

---

## Technical Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| LLM | Claude Sonnet 4.5 (Bedrock) | Best reasoning for SRE tasks, Bedrock for enterprise |
| MCP transport | stdio (uvx) | No Docker required, instant startup, AWS-native |
| Tool execution | AWS SDK v3 (not CLI) | No CLI install needed, proper credential handling |
| K8s tools | kubectl JSON parsing | Structured data, works across all K8s distributions |
| Evidence tracking | In-memory per investigation | No persistence needed within single investigation |
| History compression | Last 5 full, older key lines | Balance between context and token budget |
| Max tokens | 3072 steps / 4096 conclusions | Prevents truncation while managing cost |
| Memory DB (MVP) | SQLite + brute-force cosine | Zero infra, <1000 patterns don't need index |
| Memory DB (prod) | Aurora PostgreSQL + pgvector | Single DB for structured + semantic, team knows Postgres |
| Embeddings | Bedrock Titan Embeddings v2 | 1024-dim, native AWS, low latency from ap-south-1 |
| Pattern search | Cosine similarity > 0.7 threshold | Balance precision (avoid false matches) vs recall |
