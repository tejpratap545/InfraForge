# infra-copilot

Production-grade multi-tenant CLI to parse infra intent, generate safe plans, require approval, and execute Terraform workflows on AWS.

## Features

- Intent parsing with Bedrock (Claude Sonnet model) into structured JSON.
- Interactive CLI prompts for missing values (region, instance type, names).
- Plan-first workflow with explicit approval gating before apply.
- Terraform execution via MCP integration layer.
- Debug mode with mock logs/metrics/errors + LLM analysis.
- Multi-tenant context, subscription controls, in-memory rate limiting, and structured tracing logs.

## Commands

- `infra create --input "<intent>" --tenant-id t1 --user-id u1 --subscription pro`
- `infra plan --input "<intent>" --tenant-id t1 --user-id u1 --subscription pro`
- `infra apply --input "<intent>" --tenant-id t1 --user-id u1 --subscription pro`
- `infra ask --question "how many k8s clusters do we have?" --tenant-id t1 --user-id u1 --subscription pro`
- `infra debug --service "checkout-api" --tenant-id t1 --user-id u1 --subscription pro`

## Environment

- `AWS_REGION` (optional, default `us-east-1`)
- `LOG_LEVEL` (optional, one of `debug`, `info`, `warn`, `error`; default `debug`)
- `BEDROCK_MODEL_ID` (optional, defaults to `global.anthropic.claude-sonnet-4-5-20250929-v1:0`, then falls back to `mistral.mistral-large-3-675b-instruct` if Anthropic access is blocked by Marketplace billing or first-time-use requirements)
- `TENANT_ID` (required if `--tenant-id` not passed)
- `USER_ID` (required if `--user-id` not passed)
- `SUBSCRIPTION_TIER` (`free` | `pro` | `enterprise`, default `free`)

## Setup

```bash
npm install
npm run build
```

Run locally:

```bash
npm run dev -- --log-level error --tenant-id t1 --user-id u --region ap-south-1
```

Ask mode examples:

```bash
npm run dev -- ask --question "how many k8s clusters do we have?" --tenant-id t1 --user-id u1
npm run dev -- ask --question "list our s3 buckets" --tenant-id t1 --user-id u1
npm run dev -- ask --question "give me an AWS inventory summary" --tenant-id t1 --user-id u1
```


