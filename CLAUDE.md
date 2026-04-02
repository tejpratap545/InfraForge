# infra-copilot — AI SRE Investigation Platform

## What This Is

An AI-powered SRE investigation and infrastructure management CLI

**Current phase: Core quality** — making every investigation produce accurate, actionable root cause analysis.

## Project Goal

Build an AI system that can:
1. Investigate production incidents end-to-end (like a Staff+ SRE on-call)
2. Execute 20-30 tool calls per investigation across AWS, K8s, databases
3. Produce evidence-backed root cause analysis with specific remediation
4. Eventually: Slack bot, persistent memory, Jira/GitHub automation, proactive detection

See `docs/infra-tool-roadmap.md` for the full roadmap.

## Architecture

See `docs/architecture.md` for detailed diagrams and flows.

**Key components:**
- `src/agents/diagnoseAgent.ts` — Senior SRE investigation engine (4-phase: TRIAGE → CORRELATE → HYPOTHESIZE → ROOT CAUSE)
- `src/agents/askAgent.ts` — AWS inventory/metrics/K8s question answering
- `src/services/diagnoseTools.ts` — 16 diagnostic tools (AWS SDK + K8s + MCP)
- `src/services/awsMcpService.ts` — Multi-server MCP client (30+ AWS servers)
- `src/services/bedrockService.ts` — LLM (Claude Sonnet 4.5 via Bedrock)

## Commands

```bash
npm run build          # TypeScript compile
npm run dev -- diagnose -q "why is checkout-api returning 5XX?"
npm run dev -- ask -q "how many EKS clusters?"
npm run dev -- create --input "create RDS PostgreSQL"
npm run dev -- update --tf-dir ./infra --input "add node group"
```

## Environment Variables

```bash
# Required: Bedrock credentials (LLM account)
BEDROCK_ACCESS_KEY_ID=...
BEDROCK_SECRET_ACCESS_KEY=...

# Required: Tenant AWS credentials (infrastructure to investigate)
TENANT_AWS_ACCESS_KEY_ID=...
TENANT_AWS_SECRET_ACCESS_KEY=...

# Required: Identity
TENANT_ID=...
USER_ID=...

# Optional: MCP servers for richer tools
AWS_MCP_SERVERS=cloudwatch,cloudtrail,ecs,eks
AWS_PROFILE=my-profile
AWS_REGION=ap-south-1
```

## Tool Set (16 tools in diagnoseTools.ts)

| Category | Tools |
|---|---|
| Core | `run_command`, `aws_query`, `aws_get`, `ec2_exec` |
| Observability | `cw_metrics`, `cw_logs`, `pi_top_sql` |
| Infrastructure | `ecs_describe`, `elb_health`, `cloudtrail`, `asg_activity`, `route53_check` |
| Kubernetes | `k8s_pods`, `k8s_events`, `k8s_logs` |
| MCP | `mcp_tool` (routes to 30+ AWS MCP servers) |

## Key Design Decisions

- **No hardcoded Unit in cw_metrics** — CloudWatch returns native unit (supports counts, bytes, ms, %, etc.)
- **ec2_exec uses SSM SDK** — no AWS CLI dependency, proper credential chain
- **Evidence board** — auto-extracts key findings (errors, deploys, crashes) and presents to LLM every step
- **History compression** — last 5 steps full, older steps compressed to key lines
- **Token budget** — 3072 for tool steps, 4096 for conclusions, auto-retry on truncation
- **Parallel fan-out** — up to 8 concurrent tool calls, capped for safety
- **Pattern recognition** — 5 incident patterns (deploy, resource exhaustion, dependency, traffic, single-host)

## What NOT to Do

- Don't add `Unit: StandardUnit.Percent` to cw_metrics — it filters out non-% metrics
- Don't shell out to AWS CLI — use SDK clients for all AWS operations
- Don't truncate tool output below 1000 chars — LLM needs enough data to reason
- Don't compress history below last 5 steps — loses critical context
- Don't set maxTokens below 3072 for diagnose steps — causes truncated conclusions
- Don't add tools without updating the tool catalog in `buildToolCatalog()`
- Don't add tools without updating the dispatcher in `executeTool()`

## Coding Patterns

- All tools return strings (never throw) — errors are part of the output the LLM reasons about
- AWS clients constructed per-call with `awsConfig(ctx, region)` helper
- Tool params are `Record<string, string>` — LLM generates all values dynamically
- Safety blocklist in `isSafe()` prevents destructive shell commands
- MCP tools auto-route by name — LLM can call them directly without `mcp_tool` wrapper

## Testing an Investigation

```bash
# Quick test: ask a simple inventory question
npm run dev -- ask -q "how many RDS instances?" --tenant-id test --user-id test

# Full investigation test
npm run dev -- diagnose -q "why is checkout-api latency high?" --tenant-id test --user-id test

# With MCP servers for richer tool set
AWS_MCP_SERVERS=cloudwatch,cloudtrail npm run dev -- diagnose -q "what changed in the last 3 hours?"
```

## Next Steps (Priority Order)

1. **Datadog integration** — metrics, monitors, APM traces
2. **Memory layer** — service map, incident history, ownership
3. **Slack bot** — thread-based investigation in Slack channels
4. **Jira/GitHub** — auto-create tickets and PRs from findings
5. **Proactive detection** — auto-investigate when alarms fire
