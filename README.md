# Message Service (GraphQL / Apollo Server + Prisma + PostgreSQL on GKE)

A GraphQL API (Node.js 22+/TypeScript, [Apollo Server](https://www.apollographql.com/docs/apollo-server/))
exposing `Message` and `Author` types, persisting through [Prisma](https://www.prisma.io/) against a
PostgreSQL database, deployed to a GKE cluster through GitOps (Argo CD). It ran on a local
[kind](https://kind.sigs.k8s.io/) cluster until the migration recorded in
[MIGRATE-TO-GKE.md](MIGRATE-TO-GKE.md).

This is a GraphQL rewrite of a sibling Spring Boot + MyBatis REST API (`k8s-springboot-mybatis-o2`,
kept as the local `java-origin` git remote for reference — see [Git history](#git-history) below).
The platform layout (Gateway, Cloud SQL via Crossplane, External Secrets, Argo CD app of apps,
Kyverno, the observability stack) follows the sibling gRPC project `gke-quarkus-grpc-o2-multi`.

This repo also hosts a second, independent GraphQL API alongside this one: **issue-service**
(`issue-service/`), a Jira-lite issue tracker with a more complex schema (nested relations, enums,
threaded comments, cursor pagination). Same stack (Apollo Server + Prisma + Express), same
cluster, its own Deployment/Service/HPA/PDB, its own route on the Gateway and its own database and
user on the shared Cloud SQL instance — see [Issue Service](#issue-service-second-graphql-api) below.

## Stack URLs

Once `gke-bootstrap.sh` completes (see [Deployment to GKE](#deployment-to-gke)):

| Component | URL | Notes |
| --- | --- | --- |
| message-service GraphQL | `https://graphql.miqui.dev/graphql` | [Apollo Server](#graphql-api); Cloud Armor allowlist only |
| message-service health | `https://graphql.miqui.dev/health/liveness` | |
| issue-service GraphQL | `https://graphql.miqui.dev/issues/graphql` | see [Issue Service](#issue-service-second-graphql-api) |
| issue-service health | `https://graphql.miqui.dev/issues/health/liveness` | |
| Argo CD | `https://localhost:8081` | `./gke-port-forward.sh`; `admin` / initial admin secret |
| Grafana | `http://localhost:3000` | `./gke-port-forward.sh`; credentials from Secret Manager |
| Prometheus | `http://localhost:9090` | `./gke-port-forward.sh` |
| OpenObserve | `http://localhost:5080` | `./gke-port-forward.sh`; credentials from Secret Manager |
| Headlamp | `http://localhost:4466` | `./gke-port-forward.sh`; read-only token |
| Polaris | `http://localhost:8082` | `./gke-port-forward.sh` |

The APIs are the only thing reachable from the internet, and only from the source ranges in the
`graphql-allowlist` Cloud Armor policy (default: the IP `gke-deploy.sh` ran from). Every tool is
port-forward only, through the IP-locked, IAM-authenticated GKE API server.

## Architecture

- **API**: Apollo Server (`src/schema.ts` typeDefs) -> resolvers (`src/resolvers.ts`) -> Prisma Client
  (`src/prisma.ts`), served over Express at `POST /graphql`.
- **Data model**: `Author` (id, name, email) has many `Message`s (id, title, content, `version` for
  optimistic locking, `author` relation) - see [prisma/schema.prisma](prisma/schema.prisma). Prisma
  migrations (`prisma/migrations/`) replace the old `schema.sql`; `prisma migrate deploy` runs
  idempotently on every container startup (see the Dockerfile's `ENTRYPOINT`).
- **Cluster** (`gke-deploy.sh`): zonal GKE Standard control plane in `us-central1-a`, private
  `e2-standard-2` nodes spread over `us-central1-a/b/c` (autoscaling 3-6), Dataplane V2
  (NetworkPolicy enforcement), Workload Identity, Gateway API. No node pinning: both APIs run 3+
  replicas with hostname + zone topology spread and a PodDisruptionBudget (`k8s/pdb.yaml`), and an
  HPA each (3-6 replicas, CPU 70% / memory 80%) reading GKE's built-in metrics-server.
- **Database**: one Cloud SQL for PostgreSQL 16 instance (private IP only, TLS required), requested
  as a `PostgresInstance` (`k8s/postgres.yaml`) and provided by the Crossplane Composition in
  `k8s/platform/`. It holds `messagedb` (user `message_app`) and `issuedb` (user `issue_app`), each
  user's password from its own ExternalSecret. `postgres-exporter` is a standalone Deployment.
- **Lookup cache**: `message(id)` reads through a `messages` map on a standalone
  [Hazelcast](https://github.com/hazelcast/hazelcast) member (`k8s/hazelcast-deployment.yaml`,
  `k8s/hazelcast-service.yaml`) that each `message-service` pod connects to as a **client**
  (`src/cache.ts`) rather than embedding a member per pod - that keeps the cache independent of app
  pod restarts/scaling. `updateMessage`/`deleteMessage` evict the entry to keep the shared cache
  correct.

  There's deliberately no client-side Near Cache here: it was tried (in the original Java version of
  this app) and removed after verifying, in a real multi-pod deployment, that it went stale across
  pods after an evict - a pod other than the one that wrote an update kept serving old data
  indefinitely, since the client SDK's cross-client near-cache invalidation broadcast wasn't reliably
  reaching the other pod's near-cache. Reads go straight to the shared Hazelcast member instead,
  which stays correct - see `src/cache.ts`'s comments. Connecting to Hazelcast is not optional: same
  as the DB connection, a missing/unreachable member fails startup rather than silently running
  without a cache.
- **Public entry** (`k8s/gateway.yaml`): a GKE Gateway (global external Application Load
  Balancer) on `https://graphql.miqui.dev` with a Google-managed certificate, TLS 1.2+, HTTP -> HTTPS
  redirect and a Cloud Armor allowlist. `/issues/*` goes to `issue-service` with the prefix stripped
  (as the old nginx `rewrite-target` did); everything else to `message-service`.
- **Observability** (`k8s/observability/`, namespace `observability`): the app pushes metrics as OTLP
  (`@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`, see `src/telemetry.ts`)
  to an **OpenTelemetry Collector** (`otel-collector`, `otel/opentelemetry-collector-contrib`), which
  re-exposes them in Prometheus format on port 8889. **Prometheus** scrapes the collector, and
  **Grafana** (provisioned with that Prometheus datasource and pre-built dashboards — request
  rate/latency, event-loop lag, process memory, Prisma connection-pool stats) is reached through
  `gke-port-forward.sh` (credentials from Secret Manager via `k8s/observability/externalsecrets.yaml`).

  **OpenObserve** (`openobserve/openobserve-standalone` Helm chart - single-node, not the HA chart;
  an Argo CD Application, values in `k8s/observability/openobserve-values.yaml`) is a second,
  independent observability backend, fed by Prometheus `remote_write`. Root credentials come from
  the `openobserve-root-credentials` ExternalSecret; Prometheus and the collectors log in with the
  same values via `openobserve-remote-write-credentials`. Query its data under the `default` org, stream
  names matching the Prometheus metric names (e.g. `graphql_requests_total`,
  `container_memory_working_set_bytes`).

  **[Headlamp](https://headlamp.dev/)** (`headlamp/headlamp` Helm chart, own `headlamp` namespace -
  a general-purpose Kubernetes web UI, not part of the message-service metrics pipeline above;
  an Argo CD Application, values in `k8s/headlamp/headlamp-values.yaml`) gives a browse/inspect
  view over the cluster, a different job than Grafana/OpenObserve's time-series metrics. Port-forward
  only, and **read-only**: its ServiceAccount has the built-in `view` role plus
  `k8s/headlamp/manifests/cluster-read-rbac.yaml` (no Secrets, no exec, no writes). Log in with
  `kubectl create token headlamp -n headlamp --duration=1h`.

  Headlamp's image bundles the official
  [Prometheus plugin](https://github.com/headlamp-k8s/plugins/tree/main/prometheus)
  (`config.staticPlugins.enabled: true` in `k8s/headlamp/headlamp-values.yaml`, the chart default),
  which adds metrics charts to workload detail pages. It auto-detects Prometheus in-cluster via the
  `headlamp-prometheus: "true"` label on `k8s/observability/prometheus-service.yaml` - no extra
  per-cluster config needed.

  `write_relabel_configs` in `k8s/observability/config/prometheus.yml` deliberately keeps only
  four scrape jobs - `otel-collector` (the message-service's own metrics), plus `node-exporter`,
  `kube-state-metrics`, and `kubernetes-nodes-cadvisor` (the same three jobs behind the cluster
  ops Grafana dashboard) - not every job Prometheus scrapes. See `PROMETHEUS.md` for why (an earlier
  attempt at forwarding everything unfiltered overflowed OpenObserve's single-node in-memory MemTable).

## Continuous Deployment with ArgoCD

Everything inside the cluster is GitOps. `gke-bootstrap.sh` Helm-installs Argo CD and applies one
root Application (`k8s/argocd/root-application.yaml`, "app of apps"), which syncs every other
Application in `k8s/argocd/apps/` from this repo's `main` branch - including Argo CD itself. Sync
waves order them, and a wave starts only once the previous one is Healthy:

| Wave | Applications |
| --- | --- |
| -4 | `argocd` (self-managed), `external-secrets`, `crossplane` |
| -3 | `kyverno`, `platform` (ClusterSecretStore, Crossplane provider/functions, `PostgresInstance` API) |
| -2 | `kyverno-policies` |
| -1 | `observability`, `headlamp`, `polaris`, `trivy-operator`, `argocd-image-updater` |
| 0 | `openobserve` |
| 1 | `graphql-api` (`k8s/`: Cloud SQL, Hazelcast, both services, Gateway) |

- **CI** (`.github/workflows/message-service-ci.yml`, `issue-service-ci.yml`): on push to `main`,
  path-filtered per service, `npm ci && npm run build` as a typecheck gate, then build and push
  `us-central1-docker.pkg.dev/k8s-dev-412419/graphql-apollo-prisma-o2/<service>` (amd64), tagged
  `<UTC yyyymmddHHMMSS>-<7-char sha>` plus `:latest`. Pushing is **keyless**: GitHub's OIDC token
  is exchanged via Workload Identity Federation for the `ci-graphql-apollo-prisma-o2` service
  account, which can only write to that repository. Set the repository variables
  `GCP_WIF_PROVIDER` and `GCP_CI_SA` that `gke-deploy.sh` prints.
- **Argo CD Image Updater** (`k8s/argocd/image-updater/imageupdater.yaml`) watches both images,
  considers only timestamped tags and picks the newest (`alphabetical`), then patches the
  `graphql-api` Application's Kustomize image overrides directly - no git commits. It reads Artifact
  Registry with a short-lived Workload Identity token (no stored credential). The root Application
  ignores `spec.source.kustomize` on `graphql-api` so it doesn't undo those updates.
- **Secrets**: none in git. 1Password -> `gke-secrets-seed.sh` -> GCP Secret Manager (`gql-*`) ->
  External Secrets Operator (Workload Identity) -> Kubernetes Secrets. The old placeholder Secrets
  and `ignoreDifferences` workaround are gone.
- **Login**: `./gke-port-forward.sh argocd`, then `admin` / `kubectl -n argocd get secret
  argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`.

See [ARGOCD.md](ARGOCD.md) for operating details.

## Policy as Code with Kyverno

[Kyverno](https://kyverno.io/) admission-controls what may run in the cluster, and the *same*
policies are checked against the manifests in CI before a change merges. They use Kyverno's
CEL-based `policies.kyverno.io/v1` types (`ValidatingPolicy`, `PolicyException`); the older
`ClusterPolicy` is deprecated (Kyverno's docs schedule its removal for v1.20), so don't copy
examples that use it.

- **Delivery**: Kyverno itself is the `kyverno` Argo CD Application (chart pinned, values in
  `k8s/kyverno/kyverno-values.yaml`); the policies are a separate Application
  (`kyverno-policies`) syncing `k8s/policies/` with `prune` + `selfHeal`, so a rule deleted from git
  stops being enforced and a policy edited or deleted by hand is put back.
- **Layout** (`k8s/policies/`): `rules/` holds each rule body once, unscoped. Two kustomize overlays
  turn them into a **Deny** copy for the `default` namespace (`overlays/enforce-default`, names get
  an `-enforce` suffix) and an **Audit** copy for `observability`, `headlamp` and `polaris`
  (`overlays/audit-other`, `-audit`) - the same rule, enforced where this repo owns and has hardened
  the workloads, report-only where it doesn't yet. `audit-only/` holds rules that only ever audit,
  and `exceptions/` the `PolicyException`s.

| Policy | What it checks | Mode |
| --- | --- | --- |
| `disallow-host-access` | no privileged containers, `hostNetwork`/`hostPID`/`hostIPC`, `hostPath` volumes or `hostPort`s (a Pod Security Standards "baseline" subset) | Deny in `default`, Audit in `observability`/`headlamp` |
| `require-secure-container-context` | every container, init containers included: `runAsNonRoot`, `allowPrivilegeEscalation: false`, drop `ALL` capabilities, `RuntimeDefault`/`Localhost` seccomp (a "restricted" subset; pod-level values count as defaults) | same |
| `require-resources` | CPU and memory requests **and** limits on every container | same |
| `restrict-image-repositories` | image must be on an exact-repository allowlist (tags/digests ignored; `postgres:16-alpine` is normalized to `docker.io/library/postgres`) | same |
| `disallow-latest-tag` | image pinned to a tag other than `:latest`, or a digest | Audit only |
| `restrict-cluster-admin-bindings` | `ClusterRoleBinding`s to `cluster-admin` (built-in `system:`/`gke-`/`gcp:` ones skipped) | Audit only, cluster-wide |

Rules that match Pods also cover Deployments, StatefulSets and DaemonSets (Kyverno "autogen"), so a
non-compliant Deployment is rejected when ArgoCD applies it rather than stalling later as
ReplicaSet events. `disallow-latest-tag` is audit-only on purpose: `k8s/kustomization.yaml`'s
`newTag: latest` is the fallback for the very first sync, before Image Updater swaps in a timestamped
tag, so denying it would block the first rollout.

**Hardened workloads.** To pass the enforce set, the `default`-namespace workloads set a
`securityContext`: message-service/issue-service run as uid/gid 1000 (the image's `USER node` is a
name, not a number, so `runAsUser` has to be explicit for `runAsNonRoot` to be verifiable),
postgres-exporter as 65534 and hazelcast as 100:101, all with privilege escalation off and all
capabilities dropped.

**Exceptions** (`k8s/policies/exceptions/`) record known, accepted violations: `node-exporter` (it
needs `hostNetwork`/`hostPID`, a `hostPath` mount of `/` and a `hostPort` to read node metrics) is
exempt from the host-access and container-context audit rules, as is the log collector's
`hostPath` read of `/var/log/pods`. (Headlamp no longer has a `cluster-admin` binding, so its old
exception is gone.) They live in the
`kyverno` namespace because that is the only place `features.policyExceptions` honours them. To add
one, create the file, list it in that directory's `kustomization.yaml`, and reference the
**suffixed** policy name in `policyRefs` (e.g. `require-secure-container-context-audit`).

### Checking manifests before merge

`.github/workflows/policy-check.yml` runs `check-policies.sh` on pull requests and on pushes to
`main` that touch `k8s/`. Run it locally the same way (needs `kubectl` and the Kyverno CLI, e.g.
`brew install kyverno`):

```bash
./check-policies.sh
```

1. The **enforce** policies against `k8s/` must pass - this is the blocking part.
2. The **audit** policies against `k8s/` and `k8s/observability/` are only reported (in the job
   summary in CI): today that is the `:latest` fallback and the four `observability` Deployments
   that still have no `securityContext`.
3. A **self-test** requires the enforce policies to reject `.github/policy-fixtures/violating-deployment.yaml`,
   and the run fails if no rules loaded, a policy errors, or nothing passed - otherwise a policy that
   silently stopped matching would let the check pass vacuously.

Enforce and audit are separate runs because the Kyverno CLI exits 1 on any failure and its
`--audit-warn` flag doesn't tell Deny from Audit for the CEL policy types. `PolicyException`s are
passed with `--exception`: in the same file as the policies the CLI loads nothing. CI installs the
CLI pinned to `v1.19.1` (SHA-256-checked) to match the Helm chart; bump the two together.

### Working with the policies

A `kubectl` cheat sheet for debugging denials, audit findings and Kyverno itself is in
[KYVERNO.md](KYVERNO.md).

- **Reports**: audit findings, and exceptions applied, appear in Kyverno's policy reports
  (`kubectl get policyreport -A`, plus `kubectl get clusterpolicyreport` for cluster-scoped ones).
- **New image**: add its repository to `allowed` in `k8s/policies/rules/restrict-image-repositories.yaml`
  (one list serves both the enforce and audit copies), or the enforce set will reject it.
- **New namespace / widening enforcement**: change the `namespaceSelector` in the overlays' patches.
  The webhook additionally never sees `kube-system`, `argocd`, `crossplane-system`,
  `external-secrets` or GKE's managed namespaces (`config.webhooks` in `kyverno-values.yaml`), so
  an unhealthy Kyverno can't block system, GitOps or platform changes.
- **Promoting an audit policy to enforce**: for a namespaced rule like `disallow-latest-tag`, fix
  what it flags first, then move it from `audit-only/` into `rules/` (and drop its own
  `namespaceSelector` - the overlays add one) so it gets Deny/Audit copies like the others; any
  exception's `policyRefs` then need the `-enforce`/`-audit` suffix. `restrict-cluster-admin-bindings`
  is cluster-scoped, so it stays where it is. Confirm with `./check-policies.sh`.

### Status and limits

- Kyverno v1.19 is tested against Kubernetes 1.33-1.35; GKE's stable channel is within or close
  to that. If the policies misbehave after a GKE upgrade, suspect this first.
- `restrict-image-repositories` is exact-match on the *spelling*: `index.docker.io/...` is rejected
  even though it is Docker Hub. Only images in this repo's manifests are checked in CI - the
  Headlamp and OpenObserve charts are not rendered, so their pods are covered by the in-cluster audit
  policies only.
- The `observability` workloads are report-only until they get their own `securityContext`s.
- **Fail-closed on `default`.** The enforce policies keep Kyverno's default `failurePolicy: Fail`, and
  Kyverno runs one replica here, so while it is down (a restart or a node drain) pod creation in `default` is rejected and retries until Kyverno is back. The audit policies
  set `failurePolicy: Ignore` - they can never deny, so an outage must not block anything on their
  account. Excluded namespaces (see above) are unaffected either way.
- **Reports need RBAC.** Kyverno's reports controller can only scan kinds the chart granted it;
  `reportsController.rbac.clusterRole.extraResources` in `kyverno-values.yaml` adds
  `clusterrolebindings` for `restrict-cluster-admin-bindings`. A policy on any other kind the chart
  doesn't cover needs the same, or it audits at admission time but produces no background results.
  Only the reports controller needs it. The policy's `ready` status is recomputed only when the
  policy object is reconciled, so after fixing RBAC on a running cluster re-apply or touch the policy
  (`kubectl annotate validatingpolicy <name> touched=$(date +%s) --overwrite`) or it keeps saying
  "missing permissions". A fresh install doesn't hit this: the grant is in the Helm values, so it
  already exists when the policies are first created.

## Issue Service (second GraphQL API)

`issue-service/` is a second, fully independent GraphQL API in this same repo - same stack
(Apollo Server + Prisma + Express + TypeScript), deployed to the same cluster, but its own
npm package, own Prisma schema, own Docker image, and own set of Kubernetes manifests. It exists to
demonstrate hosting more than one GraphQL API on this stack side by side.

- **Domain**: a Jira-lite issue tracker - `Workspace` → `Project` → `Issue`, with `Label`s
  (many-to-many with `Issue`) and threaded `Comment`s (self-referential `parent`/`replies`). See
  `issue-service/prisma/schema.prisma` and `issue-service/src/schema.ts`. Compared to
  message-service's `Author`/`Message` model, this schema is intentionally more complex: a `Node`
  interface, two enums (`IssueStatus`, `Priority`), a self-relation, an implicit many-to-many, and
  Relay-style cursor pagination (`IssueConnection`/`IssueEdge`/`PageInfo`) on `Project.issues`
  instead of message-service's offset pagination.
- **Database**: its own `issuedb` database and its own `issue_app` user on the *same* Cloud SQL
  instance message-service uses (`k8s/postgres.yaml`), password from the
  `issue-service-db-credentials` ExternalSecret. Separate credentials, not separate privileges:
  users created through the Cloud SQL API are members of `cloudsqlsuperuser`, so either user can
  still reach the other's database. See [MIGRATE-TO-GKE.md](MIGRATE-TO-GKE.md#open-items).
- **No cache**: unlike message-service, issue-service does not connect to Hazelcast. Hazelcast here
  is a purpose-built read-through/write-through cache for one hot path
  (`getMessageById`/`evictCachedMessage` in message-service's `src/cache.ts`) - nothing in
  issue-service's resolvers has an equivalent proven hot path yet, so requiring Hazelcast readiness
  without using it would just add a dependency for no benefit. It can be added the same way later if
  a resolver needs it.
- **Kubernetes**: a fully separate `Deployment`/`Service`/`HorizontalPodAutoscaler` (mirroring
  message-service's, minus the `wait-for-hazelcast` init container) -
  `k8s/issue-service-deployment.yaml`, `k8s/issue-service-service.yaml`, `k8s/issue-service-hpa.yaml`.
  This means it scales and rolls out independently of message-service; a crash in one doesn't affect
  the other.
- **Routing**: a `/issues` rule on the shared Gateway's HTTPRoute (`k8s/gateway.yaml`) with a
  `URLRewrite` `ReplacePrefixMatch: /`, so the app still mounts plain `/graphql` and `/health/*`
  routes, same as message-service. The GraphQL endpoint is `https://graphql.miqui.dev/issues/graphql`.
- **Observability**: pushes the same OTLP metrics as message-service to the same OTel Collector
  (`src/telemetry.ts`), tagged with `service.name = "issue-service"` so Prometheus/Grafana can tell
  the two APIs' series apart - it isn't wired into the pre-built Grafana dashboards (those are
  scoped to message-service's metrics), but the raw series are there to query/graph.
- **Local dev**: same pattern as message-service -
  ```bash
  cd issue-service
  npm install
  DATABASE_URL=postgresql://issue_app:issue_app@localhost:5432/issuedb npm run prisma:migrate:deploy
  npm run build
  npm start
  ```
  or `npm run dev` for auto-reload. Both services' images are built and pushed to Artifact Registry
  by their own GitHub Actions workflow (see [Continuous Deployment with ArgoCD](#continuous-deployment-with-argocd)),
  and one Argo CD Application (`graphql-api`) applies both services' manifests together.

## Git history

The local `.git` directory was carried over from the original Spring Boot/MyBatis project on purpose,
as background reference for this rewrite - `git log` / `git show` against commits before this
migration still show the Java implementation. That remote is kept as `java-origin`; this project's own
GitHub remote (`origin`) is a separate, newly created repository.

## Running the Application

### 1. Local run against PostgreSQL + Hazelcast

Start a local PostgreSQL instance, plus a local
Hazelcast member for the cache, and point the app at both:

```bash
docker run --rm -d --name message-postgres \
  -e POSTGRES_DB=messagedb -e POSTGRES_USER=message_app -e POSTGRES_PASSWORD=message_app \
  -p 5432:5432 postgres:16-alpine

docker run --rm -d --name message-hazelcast \
  -e HZ_CLUSTERNAME=message-service-cache \
  -p 5701:5701 hazelcast/hazelcast:5.5.0

npm install
npm run prisma:migrate:deploy
npm run build
npm start
```

*Or, for iterative development with auto-reload: `npm run dev` (uses `tsx watch`, no build step).*

Datasource connection details are configurable via environment variables (see `src/env.ts`):
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and optionally `DB_SSLMODE` (appended
as `?sslmode=`; `require` on Cloud SQL, unset locally). Defaults connect to
`localhost:5432/messagedb` with `message_app`/`message_app`. Hazelcast connection details are
`HAZELCAST_HOST`/`HAZELCAST_PORT`, defaulting to `localhost:5701`. If you skip starting a local
Hazelcast member, the app will fail to start (the client connection is required, not optional) -
that's deliberate, matching how the DB connection behaves.

The GraphQL endpoint is `http://localhost:8080/graphql` (`PORT` env var to change it); Apollo Server's
own landing page there gives you an in-browser query explorer against the live schema (see
[GraphQL API](#graphql-api) below). Liveness/readiness probes are at `/health/liveness` and
`/health/readiness`.

---

### 2. Building the app

```bash
npm install
npm run build
```

Compiles `src/` to `dist/` via `tsc` (`tsconfig.json`). `npm run prisma:generate` regenerates the
Prisma Client after any `prisma/schema.prisma` change (also run automatically whenever `npm install`
runs, via Prisma's own postinstall hook).

---

## Deployment to GKE

Three scripts, in order. All take `PROJECT_ID`, and the defaults match `k8s/` (project
`k8s-dev-412419`, cluster `graphql-cluster`, `us-central1`). The project is shared with the gRPC
platform, so every GCP resource here has its own name (`graphql-*` / `gql-*`). The GitHub Workload
Identity pool is shared deliberately.

1. **`gke-deploy.sh`** - the GCP side: APIs, service accounts (`gql-nodes`, `gql-crossplane`,
   `gql-external-secrets`, `gql-image-updater`, `ci-graphql-apollo-prisma-o2`), VPC `graphql-vpc` +
   subnet + Cloud NAT, the Private Service Access range for Cloud SQL, the private GKE cluster,
   Workload Identity bindings, Artifact Registry repo `graphql-apollo-prisma-o2`, keyless CI (WIF),
   and the public edge (static IP, SSL policy, Cloud Armor allowlist, Certificate Manager cert for
   `graphql.miqui.dev`, and Cloudflare DNS if `CLOUDFLARE_API_TOKEN` is set).
   ```bash
   op run --env-file=.env -- env PROJECT_ID=k8s-dev-412419 ./gke-deploy.sh
   ```
2. **`gke-secrets-seed.sh`** - copies the passwords from 1Password into Secret Manager (`gql-*`).
   Re-run after rotating anything.
   ```bash
   cp .env.example .env   # fill in the op:// URIs - two DB passwords, Grafana, OpenObserve
   op run --env-file=.env -- env PROJECT_ID=k8s-dev-412419 ./gke-secrets-seed.sh
   ```
3. **`gke-bootstrap.sh`** - installs Argo CD and applies the root Application, waits until every
   Application is Synced + Healthy (Cloud SQL dominates: ~10-15 min), then checks both APIs
   through the Gateway. The repo must be pushed to `github.com/miqui/gke-graphql-apollo-prisma-o2`
   (`main`, public).
   ```bash
   PROJECT_ID=k8s-dev-412419 ./gke-bootstrap.sh
   ```

Then: `./gke-port-forward.sh` for the tools, `./test-api.sh` for the APIs
(`BASE_URL=https://graphql.miqui.dev` by default).

**Tear down**: `PROJECT_ID=k8s-dev-412419 ./gke-teardown.sh` deletes the Gateway, Cloud SQL (all
data), cluster, disks and network in dependency order. It keeps the Artifact Registry, certificate,
secrets and service accounts; `--purge` removes those too.

**If your public IP changes**, both the control plane and Cloud Armor need the new one - the
commands are in `gke-deploy.sh`'s summary.

### Pushing a code change to the running cluster

1. `git push` to `main` (`src/**`/`prisma/**` etc. for message-service, `issue-service/**` for
   issue-service) runs that service's workflow, which pushes a new timestamped image to Artifact
   Registry.
2. Argo CD Image Updater (polling every 2 minutes) picks up the new tag and updates the
   `graphql-api` Application's image override for that service.
3. Argo CD rolls the Deployment; `kubectl rollout status deployment/message-service` (or
   `issue-service`) shows it.

`prisma migrate deploy` runs on every pod start (the Dockerfile's `ENTRYPOINT`), so a schema
change ships with its image. A manifest change under `k8s/` needs no CI run: Argo CD syncs it from
`main` directly. For fast iteration use `npm run dev` against a local Postgres/Hazelcast (see
[Local run](#1-local-run-against-postgresql--hazelcast)).

Cluster shape (machine type, zones, autoscaling bounds) is in `gke-deploy.sh`, outside Argo CD.

### Viewing metrics in Grafana

`k8s/observability/` is the `observability` Argo CD Application (own namespace). Start the
tunnels with `./gke-port-forward.sh`, then:

- **Grafana**: `http://localhost:3000` — log in with the `grafana-credentials` Secret (from Secret
  Manager, see `k8s/observability/externalsecrets.yaml`) and open one of eight
  pre-provisioned dashboards, all in `k8s/observability/grafana-dashboard-json-configmap.yaml` as plain
  PromQL against real, verified metric names - if you add new panels, check the exact metric names
  Prometheus actually stores first (they differ from the raw OTLP names — see below):
  - **API RED & Saturation**: the caller's-eye view of an API - GraphQL request
    rate/latency percentiles/errors by root field, Prisma connection-pool saturation, CPU throttling,
    memory vs. limit, restarts/readiness - see [API RED & Saturation Dashboard](#api-red--saturation-dashboard) below.
  - **graphql-api**: app-level request rate/latency by root field, event-loop lag, process memory,
    Prisma connection-pool stats.
  - **GraphQL Operations** / **GraphQL Errors**: traffic, latency and errors per *schema* operation
    (query/mutation and root field) and per `extensions.code` - see
    [GraphQL Operation & Error Dashboards](#graphql-operation--error-dashboards) below.

  `api-red`, `graphql-api`, `GraphQL Operations` and `GraphQL Errors` share a **Service** dropdown
  (`message-service`, `issue-service`, or both) - the two APIs push identically named metrics through
  the same collector, told apart only by the `service_name` label.
  - **Cluster ops**: cluster-wide node/pod health - nodes ready, pod phases/restarts, per-node
    CPU/memory/disk (via node-exporter), per-namespace container CPU/memory (via cAdvisor).
  - **PostgreSQL Ops & Queries**: connections, transaction/tuple rates, buffer cache hit ratio,
    locks, checkpoints, and per-query call rate/latency - see
    [PostgreSQL Metrics (postgres_exporter)](#postgresql-metrics-postgres_exporter) below.
  - **Hazelcast Cache**: cluster size, connected clients, cache hit ratio/operation rate/latency
    for the `messages` map, member heap, GC time - see
    [Hazelcast Metrics (JMX exporter)](#hazelcast-metrics-jmx-exporter) below.
  - **OpenObserve Ops**: self-monitoring for the OpenObserve backend itself (up/down, disk usage,
    process RSS/CPU/open fds/uptime, HTTP request rate & p95/p99 latency by endpoint, ingest
    rate/bytes by stream type, in-memory MemTable size, WAL bytes) - scraped from OpenObserve's own
    `/metrics`, which is off by default (`config.ZO_PROMETHEUS_ENABLED` in
    `k8s/observability/openobserve-values.yaml` - confirmed live: with it off, `/metrics` returns
    HTTP 200 with an empty body). The MemTable Size panel is worth watching directly - that's the
    exact thing that overflowed (see the cluster ops scope note above) before OpenObserve's
    resources were bumped and remote_write was scoped down.
- **Prometheus** (`http://localhost:9090` through the tunnel): scrapes `otel-collector.observability.svc.cluster.local:8889`
  (app metrics), `postgres-exporter.default.svc.cluster.local:9187` (postgres_exporter) and
  `hazelcast.default.svc.cluster.local:9404` (Hazelcast's JMX exporter) cross-namespace - see below
  for both - plus `kube-state-metrics` and every `node-exporter` pod, and every node's kubelet
  cAdvisor endpoint via the API server proxy (see `k8s/observability/config/prometheus.yml` and
  `prometheus-rbac.yaml`) for the cluster-ops dashboard.
- **OpenObserve**: `http://localhost:5080` — log in with the root credentials from Secret Manager
  (`gke-port-forward.sh` prints how to read them). It receives the
  APIs' own metrics plus cluster ops metrics (Prometheus `remote_write`s the
  `otel-collector`, `node-exporter`, `kube-state-metrics`, and `kubernetes-nodes-cadvisor` jobs into it
  — see `write_relabel_configs` in `k8s/observability/config/prometheus.yml`; every other scraped
  job is deliberately dropped before it reaches OpenObserve), under org `default`, one stream per
  Prometheus metric name (e.g. `graphql_requests_total`,
  `container_memory_working_set_bytes`, `node_memory_MemAvailable_bytes`). Query it from the UI's
  Logs/Metrics explorer, or via its search API:
  ```bash
  NOW_US=$(( $(date +%s) * 1000000 )); START_US=$(( NOW_US - 3600*1000000 ))
  curl -s -u "$ZO_ROOT_USER_EMAIL:$ZO_ROOT_USER_PASSWORD" -X POST 'http://localhost:5080/api/default/_search?type=metrics' \
    -H 'Content-Type: application/json' \
    -d "{\"query\":{\"sql\":\"SELECT * FROM \\\"graphql_requests_total\\\" ORDER BY _timestamp DESC LIMIT 5\",\"start_time\":$START_US,\"end_time\":$NOW_US,\"size\":5}}"
  ```
  (`start_time`/`end_time` are epoch microseconds; OpenObserve rejects a query whose range doesn't
  look like one, e.g. `0`.)
- **Headlamp**: `http://localhost:4466` — a general-purpose, **read-only** Kubernetes dashboard
  (not a metrics tool). Log in with a short-lived token for its `view`-bound ServiceAccount; on
  macOS pipe it straight to the clipboard (hand-copied tokens pick up stray line breaks):
  ```bash
  kubectl create token headlamp -n headlamp --duration=1h | tr -d '\n' | pbcopy
  ```
  For an admin session, mint a short-lived token for an identity that has admin rights on demand
  rather than giving Headlamp standing ones.
- **OTel Collector** (`k8s/observability/config/otel-collector.yaml`): receives OTLP metrics on
  `:4317` (gRPC) / `:4318` (HTTP) from every `message-service` pod
  (`OTEL_METRICS_URL` in `k8s/configmap.yaml` points at it) and re-exports them in Prometheus format
  on `:8889`. Two things had to be true for per-pod metrics to actually work, both already wired
  up: (1) `resource_to_telemetry_conversion.enabled: true` on the Prometheus exporter - without it,
  OTLP *resource* attributes like `k8s.pod.name` are dropped rather than becoming Prometheus labels,
  so metrics from every pod collapse into one indistinguishable series; (2) the app itself has to send
  that resource attribute in the first place (`src/telemetry.ts`, sourced from a `POD_NAME` Downward
  API env var in `k8s/deployment.yaml`).

Prometheus here has no `PersistentVolumeClaim` — its data is ephemeral and resets whenever its pod
restarts. That's fine for a dev metrics-exploration setup; add a PVC to `prometheus-deployment.yaml`
(or switch to a `StatefulSet`) if you want it to survive restarts.

### PostgreSQL Metrics (postgres_exporter)

[`postgres_exporter`](https://github.com/prometheus-community/postgres_exporter) runs as its own
Deployment (`k8s/postgres.yaml`), connecting to Cloud SQL's private IP over TLS as `message_app`
(`message-service-db-credentials`). Prometheus scrapes it cross-namespace via
`postgres-exporter.default.svc.cluster.local:9187`. Cloud SQL's own metrics are in Cloud Monitoring
as well.

**Ops metrics** come from postgres_exporter's built-in collectors, enabled by default: connection
counts and per-state breakdown (`pg_stat_activity_count`), transaction/tuple rates and cache hit
ratio (`pg_stat_database_*`), lock counts by mode (`pg_locks_count`), and checkpoint/buffer activity
(`pg_stat_bgwriter_*`) - note the `stat_` infix; there is no bare `pg_bgwriter_*` metric.

**Query metrics** need the `pg_stat_statements` extension, which isn't in Postgres by default:

1. Cloud SQL preloads `pg_stat_statements`; the Composition sets the `pg_stat_statements.track=all`
   database flag (also count statements run inside functions).
2. `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` is declared via Prisma's
   `postgresqlExtensions` preview feature (see `prisma/schema.prisma`'s `datasource` block) and
   applied by the initial migration - it attaches to that already-preloaded library on first deploy.
3. The exporter's `--collector.stat_statements` flag (plus `--collector.stat_statements.include_query`
   for a `queryid` -> SQL-text mapping) exposes per-`queryid` call count, total time, and rows via
   `pg_stat_statements_calls_total` / `_seconds_total` / `_rows_total` - the numeric metrics are
   labeled by `queryid`/`user`/`datname` only (not the SQL text itself, to keep cardinality sane);
   `pg_stat_statements_query_id` is the separate `queryid` -> `query` lookup table, capped at the
   top 20 statements and 1024 characters each by the exporter's own defaults.

Exporter or database-flag changes go through git like everything else (`k8s/postgres.yaml`,
`k8s/platform/postgres-composition.yaml`); a Prisma migration change needs the app image rebuilt and redeployed (see
"Pushing a code change to the running cluster" above) since `prisma migrate deploy` runs from the
image's own `prisma/migrations/` directory. Prometheus config changes roll its pod automatically
(kustomize `configMapGenerator` hash).

### Hazelcast Metrics (JMX exporter)

Hazelcast's own [Management Center has a built-in Prometheus exporter](https://docs.hazelcast.com/management-center/5.11/integrate/prometheus-monitoring)
(`hazelcast.mc.prometheusExporter.enabled`), but it turned out to be an **Enterprise-licensed
feature** - confirmed live by deploying Management Center and getting `402 LICENSE_REQUIRED` from
its `/metrics` endpoint, not just by reading the docs. Rather than requiring a paid license for a
local dev cluster, `k8s/hazelcast-deployment.yaml` instead attaches
[`jmx_prometheus_javaagent`](https://github.com/prometheus/jmx_exporter) directly to the Hazelcast
member's own JVM - a free, open-source, in-process javaagent (no separate Hazelcast license, no
remote JMX/RMI port needed) that reads the member's JMX MBeans and re-exposes them as Prometheus
text format on its own port. This is entirely on the Hazelcast server side and unaffected by the
app's own language - the standalone `hazelcast/hazelcast:5.5.0` image still runs its own JVM
regardless of what language the client (`message-service`) is written in.

- An `initContainer` (`curlimages/curl`) downloads the agent jar into a volume shared with the
  `hazelcast` container on every pod start, rather than baking it into a custom Hazelcast image.
- The `hazelcast` container's `JAVA_OPTS` sets `-Dhazelcast.metrics.jmx.enabled=true` (registers
  Hazelcast's cluster/map/operation stats as `com.hazelcast:*` JMX MBeans - off by default) and
  `-javaagent:...=9404:/etc/jmx-exporter/config.yaml` (port `9404` is the agent's own listener,
  unrelated to Hazelcast's member port `5701`). The agent's config
  (`k8s/hazelcast-jmx-exporter-configmap.yaml`) just whitelists `com.hazelcast:*` and uses the
  exporter's default attribute-derived naming rather than hand-written per-metric rules.
- `k8s/hazelcast-service.yaml` exposes port `9404` alongside `5701`, and Prometheus scrapes it
  cross-namespace via `hazelcast.default.svc.cluster.local:9404`.

**Verified metric names** (checked live via port-forward before writing dashboard panels - the
exporter's default naming isn't documented anywhere, and Hazelcast's own MBean layout isn't
guaranteed stable across versions): `com_hazelcast_metrics_<attribute>`, labeled by `prefix` (the
metric's category - `cluster`, `map`, `memory`, `gc`, `tcp.connection`, `client.endpoint`, etc.) and
`tag0` for per-instance metrics (e.g. a map name). Per-map metrics come back with `tag0` set to the
*literal string* `"name=messages"` **including the embedded quote characters** (an artifact of how
Hazelcast quotes JMX ObjectName tags, which the exporter just passes through) - matching that
exactly requires escaping those quotes twice over (once for PromQL, once for JSON), so every panel
here uses a `tag0=~".*name=messages.*"` regex substring match instead, which sidesteps the
escaping entirely. Key metrics used: `com_hazelcast_metrics_size{prefix="cluster"}` (member count),
`com_hazelcast_metrics_count{prefix="client.endpoint"}` (connected clients - matches
`message-service`'s pod count, since each pod is a Hazelcast client), `hits`/`getcount`/`putcount`/
`removecount`/`totalgetlatency`/`totalputlatency`/`ownedentrycount`/`ownedentrymemorycost`/
`evictioncount`/`expirationcount` (all `prefix="map"`, per-map via `tag0`), and
`usedheap`/`committedheap`/`maxheap` (`prefix="memory"`).

### GraphQL Operation & Error Dashboards

`graphql-operations.json` and `graphql-errors.json` break the `graphql_*` metrics down by what the
**schema** says, not by what the client chose to call things. Both services' `metricsPlugin`
(`src/telemetry.ts`, `issue-service/src/telemetry.ts`) label `graphql_requests_total`,
`graphql_request_duration_ms` and `graphql_errors_total` with:

| Label | Values | Notes |
| :--- | :--- | :--- |
| `operation_type` | `query`, `mutation`, `unresolved` | `unresolved` = the request failed parse/validation before an operation was picked. |
| `root_field` | e.g. `messages`, `createMessage`, `moveIssue`, `__schema`, `unresolved` | The schema field name (aliases are resolved), looking through fragments at the root. |
| `error_code` (errors only) | `NOT_FOUND`, `CONFLICT`, `BAD_USER_INPUT`, `GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED`, `INTERNAL_SERVER_ERROR`, ... | From `extensions.code`, so it's a small closed set. |

- **Why not the client's `operationName`?** That was the previous `operation` label. It's
  client-controlled, so anyone can mint new series at will (the collector and OpenObserve both pay for
  that - OpenObserve has already overflowed its MemTable once), and unnamed operations - which is what
  every k6 script sent - all collapsed into `anonymous`. Schema root fields are bounded and always
  present. Named operations are still visible in traces.
- **Multi-root-field operations** (`query { messages { ... } authors { ... } }`) increment the
  request counter and record their full duration once *per root field*, so a per-field breakdown
  can sum to more than the number of HTTP requests.
- **Errors are attributed to the field that failed**, using the error's `path` (its first segment is
  the root field's response key, so aliases work). An error with no path - e.g. a missing required
  variable (`BAD_USER_INPUT`) - counts against every root field of that operation. GraphQL errors
  ride in HTTP 200 responses, so none of this is visible as HTTP 5xx.
- `graphql_errors_total` is only created on the first error (an OTel counter emits nothing until
  its first `.add()`), so panels built directly on it are empty - not zero - on a healthy system.
  The ratio and total panels use `or vector(0)`; the by-code panels show "No errors".

### API RED & Saturation Dashboard

`api-red.json`'s panels follow the standard [RED method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
(**R**ate, **E**rrors, **D**uration) plus enough saturation signal to explain *why* rate/errors/
duration are moving, for the API(s) picked in the **Service** dropdown and their direct dependencies:

- **Rate**: `graphql_requests_total` overall and broken down by GraphQL root field (see
  [GraphQL Operation & Error Dashboards](#graphql-operation--error-dashboards) and the `metricsPlugin`
  in `src/telemetry.ts`).
- **Duration**: p50/p90/p95/p99 latency (overall and per-root-field) from
  `graphql_request_duration_ms`.
- **Errors**: overall error ratio (gauge, thresholds at 1%/5%) and error rate by root field, both from
  `graphql_errors_total` - a request counts as an error whenever its GraphQL response includes a
  non-empty `errors[]` array; the breakdown by `extensions.code` lives on the GraphQL Errors dashboard.
- **Saturation**: Prisma connection-pool utilization (busy/idle/open) and average query/pool-wait
  duration (`prisma_pool_connections_*` / `prisma_client_queries_*`, sampled from
  `prisma.$metrics.json()` - see `registerPrismaMetrics` in `src/telemetry.ts`), CPU throttling
  ratio, container memory vs. its limit, and pod restarts/readiness.

Unlike the old REST version of this dashboard, there's no `uri!~"/actuator.*"` filter needed: the
`graphql_*` metrics are only ever recorded for real GraphQL operations against `/graphql` (see the
Apollo plugin in `src/telemetry.ts`) - the `/health/liveness` and `/health/readiness` probe routes
never touch that instrumentation at all, so there's no probe traffic to exclude in the first place.

**Deliberately not implemented, so not claimed as covered by this dashboard**: 429/timeout/retry
rates (the app has no rate limiting or explicit downstream timeouts to measure), business-outcome
errors beyond a resolver throwing (out of scope per this dashboard's own design goal), deployment
markers, and trace exemplars (no distributed tracing is wired up in this stack - only metrics).
Downstream dependency RED for Postgres and Hazelcast already exist as their own dashboards (linked
above) rather than being duplicated here.

---

## Load Testing with k6

The repository includes four parameterized [k6](https://k6.io/) scripts using `k6-utils` to benchmark
and simulate concurrent GraphQL traffic against the API. They all follow the same conventions (same
environment variables, same VU/think-time shape), so any of the "Running the Load Tests" commands
below work with any of them - just swap the filename.

| Script | What it exercises |
| :--- | :--- |
| `k6-retrieve-messages.js` | The `messages` query (read path), including a paginated `limit`/`offset` request - see [Pagination](#pagination). |
| `k6-create-messages.js` | The `createMessage` mutation (write path); creates one shared `Author` in `setup()`. |
| `k6-message-lifecycle.js` | Full CRUD per iteration: `createMessage` -> `message` -> `updateMessage` -> `deleteMessage`. |
| `k6-invalid-requests.js` | Negative paths: invalid create (`BAD_USER_INPUT`), missing id (`NOT_FOUND`), a missing required GraphQL variable (request-level validation error, HTTP 400) - see [GraphQL API](#graphql-api). |
| `k6-transaction-isolation.js` | Concurrency/lost-update regression test for `updateMessage`'s optimistic locking - see [Concurrency & Transaction Isolation](#concurrency--transaction-isolation). |

Every GraphQL document the scripts send is a *named* operation (`CreateAuthor`, `CreateMessage`,
`GetMessage`, `UpdateMessage`, `DeleteMessage`, `ListMessages`, `GetCounter`, `IncrementCounter`), so
load-test traffic is identifiable in traces and logs. Metrics and the Grafana dashboards break
traffic down by schema root field (`createMessage`, `message`, ...), not by these names.

### Prerequisites

Install `k6` using Homebrew or your package manager:

```bash
brew install k6
```

### Script Configuration

Every script supports the same environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `VUS` | Number of concurrent virtual users | `10` |
| `DURATION` | Duration of the test run (e.g. `10s`, `1m`) | `10s` |
| `BASE_URL` | Target GraphQL endpoint URL | `https://graphql.miqui.dev/graphql` |

**Built-in Thresholds:**
- `http_req_failed`: error rate must remain below 1% (`rate<0.01`).
- `http_req_duration`: 95th percentile latency must be under 500ms (`p(95)<500`).

`k6-invalid-requests.js` is the one exception: every request in it *intentionally* triggers a
GraphQL-level error, and a resolver-thrown error (`BAD_USER_INPUT`, `NOT_FOUND`) still answers HTTP
200 (only the missing-variable case, a request-level validation error, answers 400 - see [GraphQL
API](#graphql-api)) - so `http_req_failed` isn't a meaningful signal there. It uses
`checks: ['rate>0.99']` instead, which measures what actually matters for that script: did the API
return the *correct* error shape essentially every time.

`k6-transaction-isolation.js` also deviates: a `CONFLICT` GraphQL error from a losing optimistic-lock
race is an *expected*, correct response (still HTTP 200), not a failure - see the next section for
what it's actually checking.

### Running the Load Tests

#### 1. Default Run (10 VUs for 10s)
```bash
k6 run k6-retrieve-messages.js
```

#### 2. Parameterized using `-e` flags (Recommended)
```bash
k6 run -e VUS=25 -e DURATION=30s k6-create-messages.js
```

#### 3. Parameterized using shell environment variables
```bash
VUS=50 DURATION=1m k6 run k6-message-lifecycle.js
```

#### 4. Custom endpoint / remote target
```bash
k6 run -e BASE_URL=http://localhost:8080/graphql -e VUS=20 -e DURATION=15s k6-invalid-requests.js
```

## Concurrency & Transaction Isolation

**Isolation-level review.** Nothing in this codebase sets a transaction isolation level anywhere -
Prisma opens a fresh connection per query against PostgreSQL's unmodified default
(`READ COMMITTED`). Tuning that level wouldn't have mattered here, though: the real risk isn't
*which* isolation level applies to each statement, it's that a naive `updateMessage` could run its
read and its write as two entirely separate, uncoordinated operations - no isolation level closes a
gap between two unrelated round trips.

**The bug this guards against.** A classic lost update: two concurrent callers could both read the
same row, then both write, with the second write silently overwriting the first's change with no
error to either caller.

**The fix - optimistic locking via a `version` column.** `Message` has a `version Int @default(0)`
field (see `prisma/schema.prisma`). Queries include `version`, and the `updateMessage` mutation
requires the caller to send back the version it read:

```graphql
mutation {
  updateMessage(id: "…", input: { content: "New content", version: 3 }) {
    id
    version
  }
}
```

`updateMessage` (see `src/resolvers.ts`) applies the write conditionally - Prisma's `updateMany({
where: { id, version }, data: { version: { increment: 1 }, ... } })`, which compiles to `UPDATE
messages SET ..., version = version + 1 WHERE id = $1 AND version = $2` - using **the version the
client submitted**, not a version the server re-reads for itself. That distinction matters: guarding
against a server's own just-read value only protects the few milliseconds between that read and its
own write; it can't tell whether the *client's* value was stale, and a stale client value is exactly
what happens on a real read-then-update flow. If the row has moved on since the client's read, 0 rows
match and the resolver throws a `CONFLICT` GraphQL error telling the caller to refetch and retry -
instead of silently losing their change.

**Verifying it - `k6-transaction-isolation.js`.** The script has many VUs race to increment a
counter kept in one message's `content` field: each iteration reads (`content` and `version`) then
calls `updateMessage` (submits `content + 1` guarded by the `version` it just read). Every success
must correspond to a real, distinct `+1`; `CONFLICT` errors are expected under contention and are
reported separately (`write_conflicts`), not counted as failures. Run it and compare the two custom
metrics in the summary:

```bash
VUS=20 DURATION=15s k6 run k6-transaction-isolation.js
```

```
successful_increments..........: 213    ...
final_counter_value.............: avg=212 ...   <- best-effort read; see below
write_conflicts.................: 28723  ...
```

`successful_increments` and `final_counter_value` should be equal. `final_counter_value` is read
back through the app's own `message` query, which goes through the Hazelcast-backed read-through
cache (see `src/cache.ts`) - immediately after a burst of writes, that cache's own eviction can lag
the true row by a count or two, so a trailing gap of 1-2 there is a read artifact of the *cache*, not
a lost update. To see the authoritative value, query Postgres directly:

```bash
# Cloud SQL has no in-cluster pod to exec into: run psql from a throwaway pod (DB user/password
# from the message-service-db-credentials Secret, host from cloudsql-connection).
kubectl run psql --rm -it --restart=Never --image=postgres:16-alpine \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":70,"seccompProfile":{"type":"RuntimeDefault"}}}}' \
  --env=PGHOST="$(kubectl get secret cloudsql-connection -o jsonpath='{.data.privateIP}' | base64 -d)" \
  --env=PGPASSWORD="$(kubectl get secret message-service-db-credentials -o jsonpath='{.data.DB_PASSWORD}' | base64 -d)" \
  --env=PGSSLMODE=require -- psql -U message_app -d messagedb \
  -c "SELECT content, version FROM messages WHERE title = 'k6-transaction-isolation counter';"
```

**Note:** because `updateMessage` now requires `version`, `k6-message-lifecycle.js`'s update step
sends `version: 0` (correct immediately after its own `createMessage` step, since a freshly created
message always starts at version 0).

## Pagination

The `messages` query returns a `MessagePage { items, totalCount }` rather than the whole table in one
response - unbounded against a table that's had any real traffic. It accepts two optional arguments:

| Argument | Description | Default | Bounds |
| :--- | :--- | :--- | :--- |
| `limit` | Max number of messages to return | `50` | `1`-`200` |
| `offset` | Number of messages to skip, ordered by `createdAt, id` | `0` | `>= 0` |

```graphql
query {
  messages(limit: 20, offset: 40) {
    totalCount
    items { id title content version author { name } }
  }
}
```

`totalCount` carries the *total* row count, independent of `limit`/`offset`, so a client can compute
how many pages remain (`ceil(totalCount / limit)`). Out-of-range values (`limit: 0`, `limit: 500`,
`offset: -1`, etc.) are rejected with a `BAD_USER_INPUT` GraphQL error via the same
`clampPagination`/`throwIfInvalid` path used by every other resolver-level validation (see
`src/resolvers.ts`).

The resolver's `orderBy: [{ createdAt: "asc" }, { id: "asc" }]` needs `id` as a tiebreaker so paging
stays stable even when two rows share the same millisecond-precision `createdAt` - without it, ties
could reorder across pages and either skip or repeat a row. A matching index, `@@index([createdAt,
id])` (see `prisma/schema.prisma`), keeps that sort itself from scanning the whole table on every
request; dropping it turns pagination into a full-table sort per page, which on a large table is the
difference between double-digit-millisecond and multi-second responses.

Unlike the old REST API, there's no separate "unknown query parameter" check to write:
GraphQL's schema is typed, so a client that sends a field or argument the schema doesn't declare gets
a request-level validation error (HTTP 400) automatically, before any resolver runs - see
[GraphQL API](#graphql-api) below.

## GraphQL API

The schema (`src/schema.ts`) is served at `POST /graphql`; Apollo Server's own landing page at that
same URL in a browser gives you Apollo Sandbox, an in-browser query explorer against the live schema.
Introspection and Sandbox are one switch, `GRAPHQL_INTROSPECTION`: on by default for local
`npm run dev`, off by default when `NODE_ENV=production` (which the Dockerfile sets), and turned on
explicitly for this disposable dev cluster in `k8s/configmap.yaml`. Leave it off anywhere real.
Sandbox runs its requests from the landing page itself, so it works without any CORS setup. Browsers on
*other* origins are blocked by default; list the ones that may call the API in
`CORS_ALLOWED_ORIGINS` (comma-separated exact origins, or `*` to allow everything). curl, k6 and other
non-browser clients aren't affected by CORS. There's no
separate spec file to keep in sync by hand, unlike the old REST API's generated OpenAPI document -
the schema *is* the contract, and it's enforced by the GraphQL executor itself.

**Query depth and cost limits.** The schema has cycles (`Issue.project` → `Project.issues` → …), so a
small query can fan out into a huge number of resolver calls. Each service rejects any operation nested
deeper than 10 fields (`QUERY_TOO_DEEP`) or priced above 5000 (`QUERY_TOO_COMPLEX`) with **HTTP 400**,
before a single resolver runs. Cost multiplies through `first`/`limit` and nested lists; see
[GRAPHQL-API-DESIGN.md](GRAPHQL-API-DESIGN.md) for the model and how the limits were chosen. Every query
in [EXAMPLES.md](EXAMPLES.md) is comfortably within them. Both codes show up in the
`graphql_errors_total{error_code=...}` metric.

**Two different kinds of errors, two different HTTP statuses.** This is a deliberate, spec-mandated
behavior change from the old REST API's uniform RFC 9457 problem-details responses:

- A **request error** - the query fails GraphQL parsing/validation before any resolver runs (bad
  syntax, a missing required variable, an unknown field) - answers **HTTP 400**, no `data` in the
  body.
- An **execution error** - a resolver throws (`NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`, see
  `src/errors.ts`) - still answers **HTTP 200**, with the error in the response body's `errors[]`
  array (`extensions.code` carries the machine-readable reason) and `data` set to `null` for the
  failed field. This is normal for GraphQL: a single request can partially succeed (some fields
  resolve, others error), so a single HTTP status can't represent the whole response the way it did
  for one-endpoint-one-outcome REST calls.

See [`k6-invalid-requests.js`](k6-invalid-requests.js) for both cases exercised directly.
