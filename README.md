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
- `infra ask -q "how many k8s clusters do we have?" --tenant-id t1 --user-id u1 --subscription pro`
- `infra debug --service "checkout-api" --tenant-id t1 --user-id u1 --subscription pro`
- `infra diagnose -q "why is checkout-api crashing?" --tenant-id t1 --user-id u1 --subscription pro`

### Global flags

| Flag | Env var | Description |
|---|---|---|
| `--region` | `AWS_REGION` | AWS region (default `us-east-1`) |
| `--bedrock-access-key-id` | `BEDROCK_ACCESS_KEY_ID` | Access key for the Bedrock account (LLM calls) |
| `--bedrock-secret-access-key` | `BEDROCK_SECRET_ACCESS_KEY` | Secret key for the Bedrock account |
| `--aws-access-key-id` | `TENANT_AWS_ACCESS_KEY_ID` | Access key for the tenant account (CloudWatch, CloudControl) |
| `--aws-secret-access-key` | `TENANT_AWS_SECRET_ACCESS_KEY` | Secret key for the tenant account |
| `--tenant-id` | `TENANT_ID` | Tenant identifier |
| `--user-id` | `USER_ID` | User identifier |
| `--subscription` | `SUBSCRIPTION_TIER` | `free` \| `pro` \| `enterprise` |
| `--log-level` | `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

## Environment

### General
- `AWS_REGION` (optional, default `us-east-1`)
- `LOG_LEVEL` (optional, one of `debug`, `info`, `warn`, `error`; default `debug`)
- `TENANT_ID` (required if `--tenant-id` not passed)
- `USER_ID` (required if `--user-id` not passed)
- `SUBSCRIPTION_TIER` (`free` | `pro` | `enterprise`, default `free`)

### Bedrock credentials — the AWS account where LLMs are deployed
- `BEDROCK_MODEL_ID` (optional, defaults to `global.anthropic.claude-sonnet-4-5-20250929-v1:0`, then falls back to `mistral.mistral-large-3-675b-instruct` if Anthropic access is blocked by Marketplace billing or first-time-use requirements)
- `BEDROCK_ACCESS_KEY_ID` (optional, explicit access key for the Bedrock account; falls back to SDK default chain if omitted)
- `BEDROCK_SECRET_ACCESS_KEY` (optional, paired with `BEDROCK_ACCESS_KEY_ID`)

### Tenant credentials — the AWS account being investigated or managed
- `TENANT_AWS_ACCESS_KEY_ID` (optional, explicit access key for the tenant account; falls back to SDK default chain if omitted)
- `TENANT_AWS_SECRET_ACCESS_KEY` (optional, paired with `TENANT_AWS_ACCESS_KEY_ID`)

## Setup

```bash
npm install
npm run build
```

Run locally:

```bash
npm run dev -- --log-level error --tenant-id t1 --user-id u --region ap-south-1
```

### Cross-account usage

Bedrock and the tenant account are separate AWS accounts with separate credentials. Pass both sets of keys — Bedrock credentials are used exclusively for LLM calls, tenant credentials are used for all infrastructure queries (CloudControl, CloudWatch, etc.).

```bash
# Via CLI flags
infra diagnose -q "why is checkout-api down?" \
  --tenant-id t1 --user-id u1 \
  --region eu-west-1 \
  --bedrock-access-key-id  AKIABEDROCKACCOUNT... \
  --bedrock-secret-access-key bedrock-secret... \
  --aws-access-key-id  AKIACUSTOMERACCOUNT... \
  --aws-secret-access-key customer-secret...

# Via environment variables
export BEDROCK_ACCESS_KEY_ID=AKIABEDROCKACCOUNT...
export BEDROCK_SECRET_ACCESS_KEY=bedrock-secret...
export TENANT_AWS_ACCESS_KEY_ID=AKIACUSTOMERACCOUNT...
export TENANT_AWS_SECRET_ACCESS_KEY=customer-secret...
infra diagnose -q "why is checkout-api down?" --tenant-id t1 --user-id u1 --region eu-west-1
```

If either set of credentials is omitted, the AWS SDK default credential chain is used for that account (environment variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, `~/.aws/credentials`, or IAM role).

### Ask mode examples

```bash
npm run dev -- ask -q "how many k8s clusters do we have?" --tenant-id t1 --user-id u1
npm run dev -- ask -q "list our s3 buckets" --tenant-id t1 --user-id u1
npm run dev -- ask -q "give me an AWS inventory summary" --tenant-id t1 --user-id u1
```


