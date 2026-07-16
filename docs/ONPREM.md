# AEGIS · On-Prem & Air-Gapped Deployment Guide

Target audience: platform / SRE engineers deploying AEGIS inside a
regulated environment where public LLM APIs must not be reachable
from the gateway itself (BFSI, EU AI Act high-risk systems,
FedRAMP, defence, healthcare).

This guide covers three deployment tiers:

| Tier | Cluster egress | LLM used by AEGIS itself | Complexity |
|------|----------------|--------------------------|-----------|
| **A** Default k8s | open | cloud (Claude / GPT via env keys) | lowest |
| **B** Offline mode | open at network layer, blocked at app | local (Ollama / vLLM) | medium |
| **C** Air-gapped | fully sealed (NetworkPolicy) | local, mirrored images | highest |

Tier C is the buyer bar for BFSI and EU AI Act high-risk-system
deployments. All three tiers use the same chart with different
values overlays.

---

## Prerequisites

* Kubernetes 1.26+ (CronJob v1 + PodDisruptionBudget policy/v1)
* Helm 3.11+
* A CNI plugin that enforces NetworkPolicy **egress** rules if you
  intend to use tier C (Calico, Cilium, Weave, Antrea). AWS VPC-CNI
  needs a supplementary NetworkPolicy engine; AKS kubenet does NOT
  enforce egress and is unsuitable for tier C.
* An in-cluster PostgreSQL for any deployment with replicas > 1
  (SQLite mode holds a file lock; replicated SQLite is unsafe).

---

## Tier A · Default install (open cluster)

Fastest path. AEGIS makes cloud LLM calls (with `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY`) for its NL policy compiler.

```bash
helm install aegis charts/aegis \
  -n aegis --create-namespace \
  --set gateway.env.ANTHROPIC_API_KEY=sk-ant-... \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=aegis.internal.corp
```

Storage: default SQLite on a 5 GiB PVC. Fine for a single-replica
evaluation. Upgrade to Postgres before you take the gateway past
1 replica.

---

## Tier B · Offline mode (public cluster egress, local LLM)

Public network is available at the k8s layer, but AEGIS-internal
services **must not** reach public LLM APIs. Customer-driven proxy
traffic (BYOK LLM calls forwarded through `/api/v1/llm-proxy/*`)
is unaffected — that's the customer's own egress.

### 1. Deploy an Ollama sidecar as a Service

```yaml
# ollama.yaml
apiVersion: v1
kind: Service
metadata: { name: ollama, namespace: aegis }
spec:
  ports: [{ port: 11434, targetPort: 11434 }]
  selector: { app: ollama }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: ollama, namespace: aegis }
spec:
  replicas: 1
  selector: { matchLabels: { app: ollama } }
  template:
    metadata: { labels: { app: ollama } }
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:latest
          ports: [{ containerPort: 11434 }]
          volumeMounts:
            - { name: models, mountPath: /root/.ollama }
      volumes:
        - name: models
          persistentVolumeClaim: { claimName: ollama-models }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: ollama-models, namespace: aegis }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 50Gi } }
```

Then pull the model:

```bash
kubectl exec -n aegis deploy/ollama -- ollama pull llama3.1
```

### 2. Install AEGIS with offline mode + local LLM pointed at Ollama

```bash
helm install aegis charts/aegis \
  -n aegis --create-namespace \
  --set gateway.offline=true \
  --set gateway.localLlm.enabled=true \
  --set gateway.localLlm.url=http://ollama.aegis.svc.cluster.local:11434/v1 \
  --set gateway.localLlm.model=llama3.1
```

### 3. Verify

```bash
# Confirm the boot log shows the local backend was selected.
kubectl logs -n aegis deploy/aegis-gateway | grep 'nl-policy-compiler'
# → "nl-policy-compiler LLM adapter selected backend=local url=http://... model=llama3.1"

# Prove the offline gate — POST a compile request; it must NOT hit
# Anthropic even if ANTHROPIC_API_KEY happens to be set.
kubectl port-forward -n aegis svc/aegis-gateway 8080:8080 &
curl -H "X-AEGIS-Key: $KEY" http://127.0.0.1:8080/api/v1/dsl/compile-nl \
  -d '{"description":"block stripe refunds"}'
```

---

## Tier C · Air-gapped

Fully sealed environment. No image pulls from the internet, no
egress from the gateway pod beyond in-cluster services + an
optional corporate SIEM ingress on an allow-listed CIDR.

### 1. Mirror the images to your private registry

The Helm chart pulls:
* `ghcr.io/justin0504/aegis-gateway:<tag>`
* `ghcr.io/justin0504/aegis-cockpit:<tag>`
* `ollama/ollama:latest` (only if using the Ollama sidecar)

Mirror procedure (run on a workstation with dual access):

```bash
# Pull upstream
TAG=1.2.5
for img in aegis-gateway aegis-cockpit; do
  docker pull ghcr.io/justin0504/$img:$TAG
  docker tag  ghcr.io/justin0504/$img:$TAG registry.internal.corp/$img:$TAG
  docker push registry.internal.corp/$img:$TAG
done

# Ollama (optional; skip if using vLLM / LiteLLM / etc.)
docker pull ollama/ollama:latest
docker tag  ollama/ollama:latest registry.internal.corp/ollama:latest
docker push registry.internal.corp/ollama:latest
```

Pin by **digest** rather than tag if your policy requires it — GHCR
lets you resolve the digest with:

```bash
docker inspect --format='{{.RepoDigests}}' ghcr.io/justin0504/aegis-gateway:1.2.5
```

### 2. Deploy PostgreSQL

Any managed or in-cluster Postgres 14+ is fine. The gateway auto-
migrates on first boot. For a minimal in-cluster deployment:

```bash
helm install aegis-postgres bitnami/postgresql \
  -n aegis --create-namespace \
  --set auth.database=aegis \
  --set auth.username=aegis \
  --set auth.password=CHANGE_ME \
  --set primary.persistence.size=20Gi
```

Connection string for the AEGIS values file:

```
postgres://aegis:CHANGE_ME@aegis-postgres-postgresql.aegis.svc.cluster.local:5432/aegis
```

### 3. Deploy AEGIS with the air-gapped overlay

```bash
helm install aegis charts/aegis \
  -n aegis \
  -f charts/aegis/values-airgapped.yaml \
  --set gateway.image.repository=registry.internal.corp/aegis-gateway \
  --set cockpit.image.repository=registry.internal.corp/aegis-cockpit \
  --set gateway.image.tag=1.2.5 \
  --set cockpit.image.tag=1.2.5 \
  --set gateway.database.dbUrl="postgres://aegis:CHANGE_ME@aegis-postgres-postgresql.aegis.svc.cluster.local:5432/aegis"
```

The overlay turns on:
* `AEGIS_OFFLINE=1` (application-level block on cloud LLM calls)
* `AEGIS_LOCAL_LLM_URL` pointed at the Ollama service
* `NetworkPolicy` (CNI-level egress lockdown)
* 2 replicas + PodDisruptionBudget (min available: 1)
* `readOnlyRootFilesystem: true` + seccomp `RuntimeDefault`

### 4. Verify air-gap

```bash
# 4a. Prove the pod cannot reach the public internet.
kubectl exec -n aegis deploy/aegis-gateway -- \
  timeout 3 wget -qO- https://api.anthropic.com/v1/messages || echo BLOCKED
# → BLOCKED

# 4b. Prove the pod CAN reach the local LLM.
kubectl exec -n aegis deploy/aegis-gateway -- \
  wget -qO- http://ollama.aegis.svc.cluster.local:11434/api/tags
# → JSON listing installed models

# 4c. Prove the gateway boots into offline mode.
kubectl logs -n aegis deploy/aegis-gateway | grep -E 'offline|local'
# → "nl-policy-compiler LLM adapter selected backend=local ..."
```

### 5. EU AI Act evidence pack

After the deployment has been running long enough to accumulate an
audit window (default 90 days):

```bash
kubectl port-forward -n aegis svc/aegis-gateway 8080:8080 &
curl -H "X-AEGIS-Key: $KEY" \
  "http://127.0.0.1:8080/api/v1/evidence-pack/eu-ai-act/export?window_days=90" \
  -o aegis-eu-ai-act-$(date +%F).json
```

The returned JSON is Ed25519-signed with the gateway's evidence-
signing key. To verify offline:

```bash
curl -H "X-AEGIS-Key: $KEY" \
  http://127.0.0.1:8080/api/v1/evidence-pack/public-key
# copy the public_key_pem, then use it to verify the pack with any
# ed25519 CLI (openssl, ssh-keygen, or the /verify endpoint).
```

---

## Operations

### Backup

**Postgres**: use whatever your platform provides (RDS snapshots,
managed backups, or `pg_basebackup`). AEGIS holds no state outside
the DB in Postgres mode.

**SQLite** (single-replica tiers only): back up the file on the PVC.

```bash
kubectl exec -n aegis deploy/aegis-gateway -- \
  sqlite3 /data/agentguard.db ".backup '/data/backup-$(date +%F).db'"
kubectl cp aegis/$(kubectl get pod -n aegis -l app.kubernetes.io/component=gateway -o name | head -1 | cut -d/ -f2):/data/backup-$(date +%F).db ./backup-$(date +%F).db
```

### Upgrade

```bash
helm upgrade aegis charts/aegis -n aegis -f charts/aegis/values-airgapped.yaml \
  --set gateway.image.tag=1.2.6 --set cockpit.image.tag=1.2.6 --reuse-values
```

Migrations run automatically on gateway startup. The gateway is
designed to be forward-compatible with N-1 SDK versions, so you
can upgrade the gateway before the SDKs.

### Rotate the evidence-signing key

Signing keys live in the `signing_keys` table. To rotate:

```bash
kubectl exec -n aegis deploy/aegis-gateway -- \
  node -e "require('./dist/services/signing').SigningService.rotate(require('better-sqlite3')(process.env.DB_PATH || '/data/agentguard.db'))"
```

All previously issued evidence packs remain verifiable against
the OLD `key_id` bundled in each pack; new packs use the fresh key.

### License tier

Set `gateway.license.tier` + `gateway.license.key`. Community tier
runs indefinitely; the license gate only unlocks pro/enterprise
features (SSO, SCIM, custom detectors above N, cross-tenant
analytics).

---

## Troubleshooting air-gapped installs

**Symptom**: NL policy compile silently uses heuristic backend.
* Check `gateway.localLlm.enabled=true` AND `.url` AND `.model` are all set.
* Check the boot log for `AEGIS_OFFLINE is set but no AEGIS_LOCAL_LLM_URL configured` — that's the fallback warning.

**Symptom**: `SqliteError` on gateway startup with `replicas > 1`.
* SQLite mode is single-writer. You must configure `gateway.database.dbUrl` to a Postgres before scaling replicas.

**Symptom**: Pods stuck in `ContainerCreating` after image mirror.
* `imagePullPolicy: IfNotPresent` (set in the air-gapped overlay) requires the image to already exist on the node. Pre-pull with a DaemonSet or set a specific `imagePullSecrets` for your registry.

**Symptom**: NetworkPolicy is applied but egress still succeeds.
* Your CNI doesn't enforce egress. Confirm with `kubectl get networkpolicy -n aegis` (rules present) then `kubectl exec ... curl -m 3 https://api.anthropic.com` (expected: timeout / connection refused). If it succeeds, switch CNI or add the enforcement engine (e.g., Calico + `installCniPlugin: true`).

**Symptom**: Ollama returns 404 on `/v1/chat/completions`.
* Older Ollama versions expose the OpenAI-compat endpoint at `/v1` only after `OLLAMA_ORIGINS=*` is set. Upgrade to Ollama 0.1.20+ (recommended: latest) OR use LiteLLM as an OpenAI-compat facade.
