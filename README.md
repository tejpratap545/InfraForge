# infra-copilot

AI-powered SRE investigation and infrastructure management CLI. Ask questions, diagnose incidents, and provision infrastructure — all from the terminal.

## Commands

### `ask` — Q&A about your environment

```bash
infra ask -q "how many EKS clusters?"
infra ask -q "what pods are failing in the monitoring namespace?" --k8s-context prod
infra ask -q "list all RDS instances in ap-south-1"
```

### `diagnose` — Deep incident investigation

```bash
infra diagnose -q "why is mimir crashing?"
infra diagnose -q "checkout-api returning 5XX since 10am" --reasoning deep
infra diagnose -q "cert expired on api.example.com" --namespace prod --since 2h
infra diagnose -q "high DB latency" --loki-url http://loki:3100 --k8s-context staging
```

### `plan` — Infrastructure management

```bash
# Create new infrastructure
infra plan create -i "create RDS PostgreSQL t3.medium in ap-south-1" --mode terraform
infra plan create -i "add S3 bucket with versioning enabled"          --mode aws

# Dry run — see what would change, no execution
infra plan dry-run -i "add node group to EKS cluster"

# Apply changes
infra plan apply -i "increase ECS service replica count to 4"
infra plan apply -i "add monitoring namespace" --tf-dir ./infra/eks
```

---

## Global flags

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--region` | `AWS_REGION` / `AWS_DEFAULT_REGION` / `~/.aws/config` | `ap-south-1` | AWS region |
| `--model` | `BEDROCK_MODEL_ID` | Claude Sonnet 4.5 | Bedrock model ID |
| `--reasoning` | — | `standard` | Investigation depth: `quick` (8 steps) \| `standard` (25) \| `deep` (40) |
| `--log-level` | `LOG_LEVEL` | `error` | `debug` \| `info` \| `warn` \| `error` |
| `--bedrock-access-key-id` | `BEDROCK_ACCESS_KEY_ID` | — | Access key for the Bedrock account (LLM calls) |
| `--bedrock-secret-access-key` | `BEDROCK_SECRET_ACCESS_KEY` | — | Secret key for the Bedrock account |
| `--bedrock-session-token` | `BEDROCK_SESSION_TOKEN` | — | Session token for the Bedrock account |
| `--aws-access-key-id` | `TENANT_AWS_ACCESS_KEY_ID` | — | Access key for the tenant account |
| `--aws-secret-access-key` | `TENANT_AWS_SECRET_ACCESS_KEY` | — | Secret key for the tenant account |
| `--aws-session-token` | `TENANT_AWS_SESSION_TOKEN` | — | Session token for the tenant account |
| `--tenant-id` | `TENANT_ID` | local machine user | Tenant identifier |
| `--user-id` | `USER_ID` | local machine user | User identifier |
| `--subscription` | `SUBSCRIPTION_TIER` | `pro` | `free` \| `pro` \| `enterprise` |

---

## Setup

```bash
npm install
npm run build
```

### Environment variables

```bash
# LLM account (Bedrock)
export BEDROCK_ACCESS_KEY_ID=...
export BEDROCK_SECRET_ACCESS_KEY=...

# Tenant account (infrastructure being investigated/managed)
export TENANT_AWS_ACCESS_KEY_ID=...
export TENANT_AWS_SECRET_ACCESS_KEY=...

# Optional
export AWS_REGION=ap-south-1
export BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Region is resolved in order: `--region` flag → `AWS_REGION` → `AWS_DEFAULT_REGION` → `~/.aws/config` (active profile) → `ap-south-1`.

### Cross-account usage

Bedrock (LLM) and the tenant account (infrastructure) are separate AWS accounts. Pass both credential sets:

```bash
infra diagnose -q "why is checkout-api down?" \
  --region ap-south-1 \
  --bedrock-access-key-id  AKIA... --bedrock-secret-access-key bedrock-secret \
  --aws-access-key-id      AKIA... --aws-secret-access-key     tenant-secret
```

If either set is omitted, the AWS SDK default credential chain is used for that account.

---

## `diagnose` options

| Flag | Description |
|---|---|
| `-q, --question` | What to investigate (required) |
| `--k8s-context` | kubectl context — auto-discovered from current context if omitted |
| `-n, --namespace` | Kubernetes namespace to focus on |
| `--since` | Look-back window: `30m` \| `1h` \| `6h` \| `24h` |
| `--tail` | Max log lines per source (default: 50) |
| `--log-groups` | Comma-separated CloudWatch log group names |
| `--loki-url` | Loki base URL, e.g. `http://loki:3100` |
| `--opensearch-url` | OpenSearch base URL |
| `--opensearch-index` | OpenSearch index pattern (default: `*`) |
| `--opensearch-user` | OpenSearch basic-auth username |
| `--opensearch-pass` | OpenSearch basic-auth password |
| `--reasoning` | `quick` \| `standard` \| `deep` |

## `plan` options

| Subcommand | Flag | Description |
|---|---|---|
| `create` | `-i, --input` | Plain-language intent (required) |
| `create` | `--mode` | `terraform` (default) \| `aws` |
| `dry-run` | `-i, --input` | Plain-language intent (required) |
| `apply` | `-i, --input` | Plain-language change description (required) |
| `apply` | `--tf-dir` | Path to existing Terraform directory to patch |
| `apply` | `--mode` | `terraform` (default) \| `aws` |
