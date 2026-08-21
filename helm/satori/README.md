# Katra Helm Chart

[Cognitive Memory as a Service](https://github.com/openclaw/katra) — a standalone memory server for AI agents, exposing a REST API and an MCP (Model Context Protocol) endpoint.

This chart lives in `helm/satori/` (chart name `satori`, appVersion `1.0.0`).
The server container exposes two ports: REST `9002` and MCP `3100`; when
deployed in Kubernetes you reach them through the Service's `rest` and `mcp`
ports.

## Prerequisites

- **Kubernetes 1.24+**
- **Helm 3.8+**
- **PersistentVolume** provisioner (for MongoDB and Redis data, if using the bundled subcharts)
- **S3-compatible storage** (MinIO, AWS S3, Cloudflare R2, etc.) — configure `config.S3_ENDPOINT` and `secrets.AWS_*`

## TL;DR

```bash
# Install with bundled MongoDB + Redis (local dev / quickstart)
helm install katra ./helm/satori \
  --namespace katra --create-namespace \
  --set secrets.KATRA_API_KEY=your-secure-api-key

# Port-forward to access locally (resource names follow the chart's fullname
# helper: <release>-satori unless the release name already contains "satori")
kubectl port-forward svc/katra-satori 9002:9002 -n katra &
kubectl port-forward svc/katra-satori 3100:3100 -n katra &
```

## Installation

### Quickstart (Bundled Dependencies)

```bash
# Add Bitnami repo (auto-fetched via OCI, but good to have indexed)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Install Katra with bundled MongoDB + Redis
helm install katra ./helm/satori \
  --namespace katra --create-namespace \
  --set secrets.KATRA_API_KEY=$(openssl rand -hex 16)
```

### With External MongoDB / Redis

```bash
helm install katra ./helm/satori \
  --namespace katra --create-namespace \
  --set mongodb.enabled=false \
  --set redis.enabled=false \
  --set secrets.MONGODB_URI="mongodb://user:pass@my-mongo:27017/katra?authSource=admin" \
  --set secrets.REDIS_URL="redis://my-redis:6379" \
  --set secrets.KATRA_API_KEY=$(openssl rand -hex 16)
```

### With Ingress

```bash
helm install katra ./helm/satori \
  --namespace katra --create-namespace \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=katra.example.com \
  --set ingress.tls[0].secretName=katra-tls \
  --set ingress.tls[0].hosts[0]=katra.example.com \
  --set secrets.KATRA_API_KEY=$(openssl rand -hex 16)
```

### Production Values File

Create `production.yaml`:

```yaml
replicaCount: 2
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5

mongodb:
  enabled: true
  auth:
    rootPassword: "strong-mongo-password"
  persistence:
    size: 50Gi

redis:
  enabled: true
  auth:
    enabled: true
    password: "strong-redis-password"
  master:
    persistence:
      size: 20Gi

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: katra.your-domain.com
      paths:
        - path: /api
          pathType: Prefix
          port: rest
        - path: /mcp
          pathType: Prefix
          port: mcp
  tls:
    - secretName: katra-tls
      hosts:
        - katra.your-domain.com

resources:
  limits:
    cpu: 1000m
    memory: 1Gi
  requests:
    cpu: 500m
    memory: 512Mi

podDisruptionBudget:
  enabled: true
  minAvailable: 1

secrets:
  KATRA_API_KEY: "your-strong-api-key-here"

config:
  LLM_PROVIDER: "openai"
  # Embeddings are always local in the current Katra server
  # (Xenova/all-MiniLM-L6-v2 via Transformers.js ONNX) — keep this "local".
  EMBEDDING_PROVIDER: "local"
  S3_ENDPOINT: "https://s3.amazonaws.com"
  S3_REGION: "us-east-1"
  S3_BUCKET_NAME: "katra-production"
```

Then install:

```bash
helm install katra ./helm/satori -f production.yaml -n katra --create-namespace
```

## Configuration

### Top-Level Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `replicaCount` | int | `1` | Number of Katra server replicas |
| `image.repository` | string | `openclaw/katra` | Container image repository |
| `image.tag` | string | `""` (chart appVersion `1.0.0`) | Image tag override |
| `image.pullPolicy` | string | `IfNotPresent` | Image pull policy |
| `service.type` | string | `ClusterIP` | Service type (ClusterIP, NodePort, LoadBalancer) |
| `service.ports.rest` | int | `9002` | REST API port |
| `service.ports.mcp` | int | `3100` | MCP endpoint port |

### Ingress

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ingress.enabled` | bool | `false` | Enable ingress |
| `ingress.className` | string | `""` | Ingress class (e.g., nginx) |
| `ingress.hosts` | list | `[host: katra.local]` | Host rules (default paths: `/api` → `rest`, `/mcp` → `mcp`) |
| `ingress.tls` | list | `[]` | TLS configuration |

### Resources & Scaling

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `resources.limits.cpu` | string | `500m` | CPU limit |
| `resources.limits.memory` | string | `512Mi` | Memory limit |
| `resources.requests.cpu` | string | `250m` | CPU request |
| `resources.requests.memory` | string | `256Mi` | Memory request |
| `autoscaling.enabled` | bool | `false` | Enable HPA |
| `autoscaling.minReplicas` | int | `1` | Minimum replicas |
| `autoscaling.maxReplicas` | int | `3` | Maximum replicas |
| `autoscaling.targetCPUUtilizationPercentage` | int | `80` | Target CPU % |

### Application Config (non-sensitive)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `config.PORT` | string | `9002` | REST API listen port |
| `config.MCP_PORT` | string | `3100` | MCP endpoint listen port |
| `config.HOST` | string | `0.0.0.0` | Bind address |
| `config.DATABASE_NAME` | string | `katra` | MongoDB database name |
| `config.LLM_PROVIDER` | string | `local` | LLM backend (chart accepts: local, openai, anthropic, deepseek, google, custom) |
| `config.LLM_MODEL` | string | `""` | Model to use |
| `config.LLM_BASE_URL` | string | `""` | Custom LLM endpoint (OpenAI-compatible) |
| `config.EMBEDDING_PROVIDER` | string | `local` | Embeddings backend (local, openai, custom) |
| `config.S3_ENDPOINT` | string | `http://minio:9000` | S3-compatible endpoint |
| `config.S3_REGION` | string | `us-east-1` | S3 region |
| `config.S3_BUCKET_NAME` | string | `katra-assets` | S3 bucket for assets |
| `config.MULTI_TENANT` | string | `""` | Enable multi-tenancy |
| `config.TENANT_ISOLATION` | string | `""` | Tenant isolation mode |

Current-system notes:

- `LLM_PROVIDER` is passed through to the server verbatim. The current Katra
  server supports DeepSeek, OpenAI, Moonshot, Ollama, and custom
  OpenAI-compatible providers (via `LLM_BASE_URL`).
- Embeddings are always local in the current server
  (Xenova/all-MiniLM-L6-v2, Transformers.js ONNX) — leave
  `EMBEDDING_PROVIDER` at `local`.
- Liveness/readiness probes hit `GET /api/v1/health` on the `rest` port
  (`livenessProbe`, `readinessProbe`, optional `startupProbe` in values).

### Secrets

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `secrets.KATRA_API_KEY` | string | `""` (auto-generated, 32 chars) | Admin API key — authenticates the trusted `satori` identity |
| `secrets.MONGODB_URI` | string | `""` (auto from subchart) | MongoDB connection string |
| `secrets.REDIS_URL` | string | `""` (auto from subchart) | Redis connection URL |
| `secrets.LLM_API_KEY` | string | `""` | LLM provider API key |
| `secrets.EMBEDDING_API_KEY` | string | `""` | Embeddings provider API key |
| `secrets.AWS_ACCESS_KEY_ID` | string | `""` | S3 access key |
| `secrets.AWS_SECRET_ACCESS_KEY` | string | `""` | S3 secret key |
| `secrets.JWT_SECRET` | string | `""` | JWT signing secret (SaaS) |

Identity separation: the server resolves the calling identity from the API
key presented on each request (`X-MCP-Auth` header, `Authorization: Bearer`,
or `?token=` URL param). `KATRA_API_KEY` authenticates as the trusted satori
identity; additional per-identity client keys (shoshin, zanshin) are
provisioned by the server itself at boot — you do not set them here.

### External Secret

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `envFromSecret` | string | `""` | Name of existing secret; disables built-in Secret |

### Subcharts

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mongodb.enabled` | bool | `true` | Deploy Bitnami MongoDB (chart `~15.6`) |
| `mongodb.auth.rootUser` | string | `admin` | MongoDB root user |
| `mongodb.auth.rootPassword` | string | `""` (auto) | MongoDB root password |
| `mongodb.persistence.size` | string | `8Gi` | MongoDB PVC size |
| `redis.enabled` | bool | `true` | Deploy Bitnami Redis (chart `~19.6`) |
| `redis.auth.enabled` | bool | `false` | Enable Redis auth |
| `redis.master.persistence.size` | string | `8Gi` | Redis PVC size |
| `minio.enabled` | bool | `false` | MinIO is **not** bundled as a subchart — point `config.S3_ENDPOINT` at your own S3 provider |

## Using External MongoDB/Redis

Set the subcharts to disabled and provide connection strings:

```bash
--set mongodb.enabled=false \
--set redis.enabled=false \
--set secrets.MONGODB_URI="mongodb://user:pass@host:27017/katra?authSource=admin" \
--set secrets.REDIS_URL="redis://host:6379"
```

## Using an External Secret

If you manage secrets externally (e.g., External Secrets Operator, Vault, Sealed Secrets):

```bash
# Create your own secret
kubectl create secret generic katra-env \
  --from-literal=KATRA_API_KEY=xxx \
  --from-literal=MONGODB_URI=mongodb://... \
  --from-literal=REDIS_URL=redis://... \
  -n katra

# Install referencing it
helm install katra ./helm/satori --set envFromSecret=katra-env -n katra --create-namespace
```

## Upgrading

```bash
# Update dependencies (if mongodb/redis charts updated)
helm dependency update ./helm/satori

# Upgrade the release
helm upgrade katra ./helm/satori \
  --namespace katra \
  -f production.yaml
```

### Upgrading with breaking subchart changes

When upgrading Bitnami MongoDB or Redis charts that have breaking changes (e.g., auth format changes), review the [Bitnami upgrade notes](https://github.com/bitnami/charts/tree/main/bitnami/mongodb#to-1500) first. Always backup persistent volumes before major upgrades.

## Uninstalling

```bash
helm uninstall katra --namespace katra
```

To also delete persistent volumes (⚠️ irreversible):

```bash
kubectl delete pvc -n katra -l app.kubernetes.io/instance=katra
```

## Architecture

```
┌──────────────────────────────────────────────┐
│                    Ingress                    │
│  /api → rest:9002      /mcp → mcp:3100       │
└──────────────────┬───────────────────────────┘
                   │
              ┌────▼────┐
              │  Katra   │  Deployment (REST + MCP)
              └──┬───┬──┘
                 │   │
      ┌──────────▼┐ ┌▼──────────┐
      │  MongoDB   │ │   Redis    │  Bitnami subcharts
      │  (15.6.x)  │ │  (19.6.x)  │
      └────────────┘ └────────────┘
```

## License

MIT — see the [Katra repository](https://github.com/openclaw/katra) for details.
