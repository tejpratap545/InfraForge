# infra-copilot

AI-powered SRE investigation and infrastructure management CLI. Ask questions, diagnose incidents, and provision infrastructure — all from the terminal.

## Install

```bash
npm install
npm run install:cli   # builds + npm link → installs `infra` globally
```

Or run without installing:

```bash
npm run dev -- <command> [options]
```

---

## Commands

### `ask` — Q&A about your environment

Simple question answering about live AWS and Kubernetes state.

```bash
infra ask -q "how many EKS clusters?"
infra ask -q "what pods are failing in monitoring?" --k8s-context prod
infra ask -q "list all RDS instances" --reasoning quick
```

### `diagnose` — Deep incident investigation

Root cause analysis across AWS, K8s, logs, metrics. Auto-discovers the kubectl context if not provided.

```bash
infra diagnose -q "why is mimir crashing?"
infra diagnose -q "checkout-api returning 5XX since 10am" --reasoning deep
infra diagnose -q "cert expired on api.example.com" --namespace prod --since 2h
infra diagnose -q "high DB latency" --loki-url http://loki:3100 --k8s-context staging
```

### `plan` — Infrastructure management

Three subcommands. `--mode` selects the execution engine.

```bash
# Create new infrastructure
infra plan create -i "create RDS PostgreSQL t3.medium" --mode terraform
infra plan create -i "add S3 bucket with versioning"   --mode aws

# Dry run — see what would change, no execution
infra plan dry-run -i "add node group to EKS cluster"

# Apply changes
infra plan apply -i "increase ECS service replica count to 4"
infra plan apply -i "add monitoring namespace" --tf-dir ./infra/eks --mode terraform
```

### Interactive mode

Run `infra` with no arguments to launch the interactive session. Arrow-key menus guide you through:

```
Mode       → ask | diagnose | plan create | plan dry-run | plan apply
Provider   → terraform | aws          (plan commands only)
TF dir     → auto-detected from cwd if .tf files exist, or enter a path
Reasoning  → quick | standard | deep
Model      → Claude Sonnet 4.6 | Opus 4.6 | Haiku 4.5 | Mistral Large 2
```

Slash commands while in the prompt:

| Command | Action |
|---|---|
| `/mode` | Re-pick mode |
| `/model` | Re-pick LLM model |
| `/switch` | Re-pick everything |
| `/exit` | Quit |

---

## Global flags

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--region` | `AWS_REGION` → `AWS_DEFAULT_REGION` → `~/.aws/config` | `ap-south-1` | AWS region |
| `--model` | `BEDROCK_MODEL_ID` | Claude Sonnet 4.5 | Bedrock model ID |
| `--reasoning` | — | `standard` | `quick` (8 steps) \| `standard` (25) \| `deep` (40) |
| `--log-level` | `LOG_LEVEL` | `error` | `debug` \| `info` \| `warn` \| `error` |
| `--bedrock-access-key-id` | `BEDROCK_ACCESS_KEY_ID` | — | Access key for the Bedrock account (LLM calls) |
| `--bedrock-secret-access-key` | `BEDROCK_SECRET_ACCESS_KEY` | — | Secret key for the Bedrock account |
| `--bedrock-session-token` | `BEDROCK_SESSION_TOKEN` | — | Session token for the Bedrock account |
| `--aws-access-key-id` | `TENANT_AWS_ACCESS_KEY_ID` | — | Access key for the tenant AWS account |
| `--aws-secret-access-key` | `TENANT_AWS_SECRET_ACCESS_KEY` | — | Secret key for the tenant AWS account |
| `--aws-session-token` | `TENANT_AWS_SESSION_TOKEN` | — | Session token for the tenant AWS account |
| `--tenant-id` | `TENANT_ID` | local machine user | Tenant identifier |
| `--user-id` | `USER_ID` | local machine user | User identifier |
| `--subscription` | `SUBSCRIPTION_TIER` | `pro` | `free` \| `pro` \| `enterprise` |

---

## Environment variables

```bash
# LLM account (Bedrock)
export BEDROCK_ACCESS_KEY_ID=AKIA...
export BEDROCK_SECRET_ACCESS_KEY=...
export BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-5-20250929-v1:0  # optional

# Tenant account (the AWS account being investigated / managed)
export TENANT_AWS_ACCESS_KEY_ID=AKIA...
export TENANT_AWS_SECRET_ACCESS_KEY=...

# Region — any of these work, in priority order:
export AWS_REGION=ap-south-1
# or set in ~/.aws/config under the active profile
```

If either credential set is omitted, the AWS SDK default chain is used (`~/.aws/credentials`, IAM role, etc.).

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

### Terraform auto-detection

In interactive mode, if the current directory contains `.tf` files, the TF directory is pre-filled automatically. Press Enter to confirm or type a different path.

### Engine comparison

| | `--mode terraform` | `--mode aws` |
|---|---|---|
| Plan format | HCL files | Cloud Control JSON |
| Execution | `terraform apply` | `CreateResourceCommand` |
| State tracking | `.tfstate` | AWS resource state |
| Best for | Production with drift detection | Fast provisioning |

---

## Reasoning depth

| Flag | `ask` steps | `diagnose` steps | Use case |
|---|---|---|---|
| `--reasoning quick` | 5 | 8 | Inventory checks, simple questions |
| `--reasoning standard` | 15 | 25 | Default — most incidents |
| `--reasoning deep` | 25 | 40 | Complex failures, cert/ingress/multi-service |

---

## Cross-account usage

Bedrock (LLM) and the tenant account (infrastructure) can be separate AWS accounts:

```bash
infra diagnose -q "why is checkout-api down?" \
  --region ap-south-1 \
  --bedrock-access-key-id  AKIA_BEDROCK... --bedrock-secret-access-key bedrock-secret \
  --aws-access-key-id      AKIA_TENANT...  --aws-secret-access-key     tenant-secret
```
