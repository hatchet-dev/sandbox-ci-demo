# sandboxes-tui-demo

Build and publish Docker images on Hatchet sandboxes instead of GitHub Actions. A GitHub push webhook triggers a durable `image-pipeline` task that fans out one `build-image` child per service. Each child forks a sandbox from the last warm snapshot, runs `docker build` and `docker push` inside it, streams the log over a durable stream, and snapshots the sandbox again so the next build starts with a hot layer cache. A TUI watches it all.

The sandbox never holds a registry or GitHub secret. The worker runs a small credential proxy and hands each build a one-time token. The proxy swaps that token for the real credential on the way out.

## Setup

Hatchet Cloud needs the Sandboxes labs preview on and a sandbox provider connected. In the tenant settings turn on Sandboxes, then connect a provider. The sandbox image is plain `docker:28.3.3-dind` and the worker installs git into it on first use, so no custom image is needed.

Archil is the default. Connect a provider named `archil` with your Archil API key and the config `{"region":"aws-us-east-1","workdir":"/workspace"}`. Each sandbox is a microVM with its own root disk, and a snapshot captures the whole disk including the Docker layer cache. Archil's Free plan limits egress to an allowlist that does not include the proxy tunnel, so the account needs the Developer plan or above. Sizing happens on the cold create through `SANDBOX_VCPU` and `SANDBOX_MEMORY`, and forks keep the size of their source.

Daytona also works. Connect a provider named `daytona`, build a snapshot and point `SANDBOX_TEMPLATE` at it with `SANDBOX_WORKDIR=/home/daytona` and the size variables unset. Daytona caps a sandbox disk at 10 GB, which is enough for the sample app but tight for a warm cache of real builds.

```sh
brew install daytonaio/cli/daytona
daytona login --api-key <key>
daytona snapshot create dind-build --image docker:28.3.3-dind --cpu 4 --memory 8 --disk 10
```

The worker also needs cloudflared for the proxy tunnel.

```sh
brew install cloudflared
```

Create the webhook in Hatchet under Webhooks with name `github`, source GitHub, event key expression `'github:' + headers['x-github-event']` and a secret. Add that URL as a webhook on the GitHub repo with content type `application/json`, push events only and the same secret.

Fill in the environment and install.

```sh
cp .env.example .env
set -a && . ./.env && set +a
unset HATCHET_CLIENT_TLS_ROOT_CA_FILE
pnpm install
```

## Run

The probe is the gate. It builds the sample app cold, snapshots, forks and builds again, and exits non-zero unless the second build hits the layer cache.

```sh
pnpm probe
pnpm worker
pnpm tui
pnpm build -- --ref main
```

The worker prints the proxy URL once it has a tunnel. Pushing a commit to the repo triggers a run through the webhook. The TUI lists runs on the left and streams each service's build log on the right. Press `b` to build the default branch by hand.

## Configuration

| Variable | Effect |
| --- | --- |
| `HATCHET_CLIENT_TOKEN` | Tenant to run against. Unset `HATCHET_CLIENT_TLS_ROOT_CA_FILE` for Hatchet Cloud. |
| `SANDBOX_PROVIDER` | Provider name on the tenant. Required when more than one is connected. |
| `SANDBOX_TEMPLATE` | OCI image on Archil or snapshot name on Daytona. Defaults to `docker:28.3.3-dind`. |
| `SANDBOX_WORKDIR` | Must match the provider's workdir. Defaults to `/workspace`. |
| `SANDBOX_VCPU`, `SANDBOX_MEMORY` | Size of the cold sandbox on Archil. Leave unset on Daytona unless resizing is enabled for the org. |
| `REPO_URL`, `DEFAULT_BRANCH` | Repository to build and the branch whose builds refresh the cache. |
| `SERVICES` | Comma separated `SERVER_TARGET` values, one child task each. |
| `DOCKERFILE` | Path inside the repo. Defaults to `sample/Dockerfile`. |
| `REGISTRY_UPSTREAM` | Registry the proxy forwards to. An `*.dkr.ecr.*.amazonaws.com` host switches to ECR tokens from the AWS SDK credential chain. |
| `IMAGE_PREFIX` | Image name prefix. The service name and the commit sha are appended. |
| `REGISTRY_USER`, `REGISTRY_PASSWORD` | Registry credential for non ECR upstreams. GHCR takes a PAT with `write:packages`. |
| `GITHUB_TOKEN` | Only needed for private repos. Clones go through the proxy when set. |
| `PROXY_PUBLIC_URL` | Public URL of the proxy. The worker starts a cloudflared quick tunnel when unset. |

## Using this for a real pipeline

Point `REPO_URL` at the private repo and set `GITHUB_TOKEN`. Set `REGISTRY_UPSTREAM` to the ECR host, `IMAGE_PREFIX` to the ECR repository prefix and `SERVICES` to the service list. Run the proxy on a host with a stable URL and set `PROXY_PUBLIC_URL`, because a quick tunnel caps a request body at 100 MB and large layers fail to push through it. Nothing else changes.

## Not included

Slack notifications, dependency bump commits, mirroring to a second registry, multi-arch builds and scheduled cache warming. Builds on non default branches delete their sandbox when done and never touch the cache.
