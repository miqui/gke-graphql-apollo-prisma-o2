# Migrating from kind to GKE — decisions and open items

A record of moving this project from a local kind cluster to GKE in project `k8s-dev-412419`
(project number 220906294299), following the layout of the sibling gRPC platform
`gke-quarkus-grpc-o2-multi` (its `MIGRATE-TO-GKE.md` has the problems that platform hit on first
deploy, most of which are already fixed in the scripts copied from it). Operating instructions are
in [README.md](README.md#deployment-to-gke).

**Status (2026-10-25): deployed.** First deploy of `graphql-cluster` succeeded; both APIs answer on
`https://graphql.miqui.dev` (see [First deploy](#first-deploy-2026-10-25)).

## Decisions

| Area | Before (kind) | After (GKE) | Why |
| --- | --- | --- | --- |
| Cluster | 7-node kind cluster, workloads pinned to labelled nodes | Own zonal GKE Standard cluster `graphql-cluster` in the shared project, `e2-standard-2` x 3-6 across `us-central1-a/b/c`, private nodes, IP-locked control plane, Dataplane V2, Workload Identity, Gateway API | Same platform shape as the gRPC project; independent deploy/teardown |
| Install flow | `deploy-kind.sh` (Helm + kubectl + secret injection) | `gke-deploy.sh` (GCP) + `gke-secrets-seed.sh` + `gke-bootstrap.sh` (Argo CD + one root Application); everything else is an Argo CD Application (app of apps, sync waves) | One GitOps path |
| Public entry | ingress-nginx, `localhost` + `/issues` regex rewrite | GKE Gateway on `https://graphql.miqui.dev`, Google-managed cert, TLS 1.2+, HTTP -> HTTPS, `/issues` via `URLRewrite` `ReplacePrefixMatch`, Cloud Armor allowlist | ingress-nginx is retired; the APIs have no auth, so only allowed IPs reach them |
| Tools | `*.localhost` Ingresses | Port-forward only (`gke-port-forward.sh`) | Keep tools off the internet |
| Headlamp RBAC | `cluster-admin` | `view` + read-only cluster-scoped role | Least privilege; its Kyverno exception is gone |
| Database | One Postgres StatefulSet, `messagedb` + `issuedb` (init script), one shared user | One Cloud SQL for PostgreSQL 16 instance via a Crossplane `PostgresInstance`, private IP, TLS required, `messagedb`/`message_app` and `issuedb`/`issue_app` | Managed DB as IaC; one instance's cost; separate credentials per service |
| Composition | (gRPC platform: one database + user) | `spec.databases[]` list; instance via patch-and-transform, databases/users via `function-go-templating` loop | patch-and-transform can't iterate a list |
| App code | `DATABASE_URL` without TLS | `DB_SSLMODE` env -> `?sslmode=` in both `env.ts` (unset locally) | Cloud SQL is `ENCRYPTED_ONLY` |
| Secrets | Placeholder Secrets in git, overwritten from 1Password, `ignoreDifferences` | 1Password -> `gke-secrets-seed.sh` -> Secret Manager (`gql-*`) -> External Secrets (Workload Identity) | No secret values in git or scripts |
| Images | Docker Hub, stored token, multi-arch | Artifact Registry `graphql-apollo-prisma-o2`, keyless push (GitHub OIDC -> WIF, `main` only), amd64 | No long-lived registry credentials |
| Image Updater | Docker Hub read token | Workload Identity token from the metadata server | No stored credential |
| Network | none | Default-deny NetworkPolicies in `default` (both directions), `observability`, `headlamp`, `polaris` | Enforced by Dataplane V2 |
| Extras | — | Polaris dashboard, Trivy Operator (as in the gRPC platform) | Best-practice and vulnerability reports |

### Sharing a GCP project with the gRPC platform

Everything project-scoped got its own name so the two platforms can't collide or delete each
other's resources:

| Kind | gRPC platform | This platform |
| --- | --- | --- |
| Cluster / VPC / subnet / router / NAT | `dev-cluster`, `dev-vpc`, ... | `graphql-cluster`, `graphql-vpc`, ... |
| PSA range (global address) | `cloudsql-psa-range` | `gql-cloudsql-psa-range` (same CIDR, different VPC) |
| Service accounts | `gke-dev-nodes`, `crossplane-gcp`, `external-secrets`, `argocd-image-updater`, `ci-springboot-grpc-o2` | `gql-nodes`, `gql-crossplane`, `gql-external-secrets`, `gql-image-updater`, `ci-graphql-apollo-prisma-o2` |
| Secret Manager | `postgres-app-password`, `grafana-admin-*`, `openobserve-root-*` | `gql-postgres-message-password`, `gql-postgres-issue-password`, `gql-grafana-admin-*`, `gql-openobserve-root-*` |
| Edge | `grpc-ip`, `grpc-cert*`, `grpc-tls`, `grpc-allowlist` | `graphql-ip`, `graphql-cert*`, `graphql-tls`, `graphql-allowlist` |
| Cloud SQL label (teardown leftover sweep) | `platform=gke-quarkus-grpc-o2` | `platform=gke-graphql-apollo-prisma-o2` |

**Workload Identity KSA names carry a `-gql` suffix** (`external-secrets-gql`,
`provider-gcp-gql`, `argocd-image-updater-gql`). All clusters in a project share one Workload
Identity pool, where a KSA's identity is just `<namespace>/<name>`; with the reference's KSA names
the gRPC cluster's External Secrets could have read this platform's secrets (and vice versa). The
Trivy Operator's principal (`trivy-system/trivy-operator`) is shared on purpose: it only gets
read access to the image repositories.

The GitHub Workload Identity pool `github` and its provider are shared by design (each repo has its
own binding and CI service account). `gke-deploy.sh` re-applies the provider's owner-wide condition,
which is the same value the gRPC platform sets.

## Removed

`deploy-kind.sh`, `teardown-kind.sh`, `k8s/kind-config.yaml`, `k8s/secret.yaml`,
`k8s/postgres-{statefulset,service,init-configmap}.yaml`, `k8s/ingress.yaml`,
`k8s/issue-service-ingress.yaml`, `k8s/argocd/{ingress,application,observability-application,policies-application,image-updater}.yaml`,
`k8s/observability/{ingress,grafana-secret,openobserve-prometheus-secret}.yaml`,
`k8s/headlamp/resourcequota.yaml` (moved to `k8s/headlamp/manifests/`),
`k8s/policies/exceptions/headlamp-admin.yaml`. All of it is in the baseline commit on `main`.

## Verified before deploying

Offline only:

| Check | Result |
| --- | --- |
| `kubectl kustomize` of `k8s/`, `k8s/observability/`, `k8s/platform/`, `k8s/policies/` | builds |
| `./check-policies.sh` | enforce set passes on `k8s/` (16/16); self-test fixture rejected; audit findings as expected (`:latest` fallback, observability securityContexts) |
| Composition go-template rendered with Go `text/template` against `k8s/postgres.yaml` | 2 `Database` + 2 `User`, each user wired to its own service's Secret |
| `tsc --noEmit` for both services after the `env.ts` change | passes |
| `bash -n` on all scripts; YAML parse of `k8s/` and workflows | passes |

## First deploy (2026-10-25)

`gke-deploy.sh` -> `gke-secrets-seed.sh` -> `gke-bootstrap.sh`, all through `op run`, no script changes.

| Check | Result |
| --- | --- |
| `gke-deploy.sh` | all 27 steps, exit 0; Cloudflare A + validation CNAME upserted via the API |
| CI (`main`) | image push works once `GCP_WIF_PROVIDER`/`GCP_CI_SA` are set; first tags `<timestamp>-2dfc804` |
| Argo CD | all 14 Applications Synced + Healthy; Image Updater switched both services to the timestamp tag |
| Cloud SQL (Crossplane) | instance ready in ~10 min (private IP 10.16.0.3); 2 databases + 2 users created |
| Certificate | ACTIVE ~35 min after `gke-deploy.sh`; the LB served it a further ~2 min later |
| Public endpoints | `/health/readiness` and `/issues/health/readiness` 200; DB-backed query works; HTTP -> HTTPS 301; Apollo Sandbox loads on `/graphql` and `/issues/graphql` |

What got in the way (none of it in the repo):

- **1Password service account token expired.** `op` returned `403 Forbidden` for everything (in every
  project, not just this one). Rotating the token fixed it; a Claude Code session started before
  the rotation keeps the old token in its environment until it is restarted from a fresh shell.
- **1Password item title with a leading space** (`" gql-postgres-message"`) doesn't match
  `op://dev-vault/gql-postgres-message/...`. Renamed in 1Password.
- **CI on `main` fails until the repository variables exist** (auth step:
  `must specify exactly one of "workload_identity_provider" or "credentials_json"`). Expected between
  merging and the first `gke-deploy.sh`; re-running the failed runs afterwards pushed the first images.

## Open items

1. **Cloud SQL users are not privilege-isolated** - *accepted for this short-lived dev cluster.*
   Users created through the Cloud SQL API are members of `cloudsqlsuperuser`, which owns
   API-created databases, so `message_app` can still connect to `issuedb` and the other way round.
   Real isolation would need a SQL step run as an admin user (each user owns its database,
   `REVOKE CONNECT ... FROM PUBLIC`, drop the `cloudsqlsuperuser` membership). The two 1Password
   items deliberately hold the same password on this cluster.
2. ~~`/issues` prefix rewrite on the GKE Gateway~~ - **resolved**: `ReplacePrefixMatch: /` turns
   `/issues/graphql` into `/graphql`; issue-service answers on `https://graphql.miqui.dev/issues/graphql`.
3. ~~`function-go-templating:v0.10.0`~~ - **resolved**: the package resolves and the composition's
   loop created both `Database`s and `User`s.
4. **Node pool size** - `MAX_NODES=6` is enough. Steady state is 5 nodes (the autoscaler touched 6
   during the first rollout, while old and new ReplicaSets overlapped, then scaled down). Actual CPU
   use is ~1.6 cores, but requests are ~7.1 of ~9.6 allocatable cores: per-node DaemonSets (GKE
   networking/logging, node-exporter, log-collector) take ~0.55 of each e2-standard-2's ~1.93. Both
   HPAs at 6 replicas add 1.5 cores, which fits with a 6th node. If a load test leaves pods
   Pending, lower the APIs' CPU requests (250m; they use a fraction of it) or raise `MAX_NODES`.
5. **Cost.** The GKE free-tier credit covers the control plane (~$0.10/h) of one zonal cluster per
   billing account; only one platform cluster runs at a time, so this one gets it. Nodes, the Cloud
   SQL instance and the load balancer are billed while the cluster is up - tear down with
   `gke-teardown.sh` when done.
6. **Docs still mention kind** in places: `KUBECTL.md`, `EXAMPLES.md` (`localhost` URLs), `DB.md`,
   `TRACING.md`, `KYVERNO.md`, `LOGS.md`, `HELM.md`, `NEW-PROJECT-BLUEPRINT.md`.
