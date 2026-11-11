# sandbox-ci-demo

Build Docker images in Hatchet sandboxes instead of GitHub Actions.

Each image gets its own sandbox. The sandbox stays alive between builds, so the Docker cache is always warm. A web page shows every build step live. Secrets stay on your machine. The sandbox only gets a one-time token.

## You need
  
- Hatchet Cloud with Sandboxes and Durable Streams turned on under `Settings` > `Labs Preview`.
- An Archil account on the Developer plan.
- A GitHub classic token with `write:packages`.
- Node 24, pnpm and `cloudflared`.

```sh
brew install cloudflared
```

## Setup

1. In Hatchet go to Sandboxes. Add a provider named `archil` with your Archil API key and this config.

   ```json
   {"region":"aws-us-east-1","workdir":"/workspace"}
   ```

2. Fill in the env file.

   ```sh
   cp .env.example .env
   ```

3. Install.

   ```sh
   pnpm install
   ```

## Run

```sh
set -a && . ./.env && set +a
pnpm worker
```

This starts the worker, the credentials proxy and the web UI.

Open http://127.0.0.1:8788.

Pick a repo on the left, or add one. Fill in the URL, the ref and one card per image. Press Build. Each image gets a pane on the right with the phases, the build steps, the cache count and the pushed image.

Your changes are saved to `builds.json`.

Build from a terminal instead.

```sh
pnpm build -- --repo sandbox-ci-demo --ref main
pnpm build -- --repo https://github.com/owner/repo.git --dockerfile Dockerfile --context .
```

## builds.json

```json
{
  "repos": [
    {
      "url": "https://github.com/owner/repo.git",
      "ref": "main",
      "images": [
        { "name": "api", "dockerfile": "Dockerfile", "context": ".", "stage": "api", "args": { "VERSION": "1" } }
      ]
    }
  ]
}
```

`stage` and `args` are optional. The image is pushed as `<IMAGE_PREFIX>/<repo>-<name>:<sha>`. Set `image` on an entry to pick your own full name.

## Build on push

In Hatchet, add a webhook named `github` with source GitHub, the key expression `'github:' + headers['x-github-event']` and a secret.

In each GitHub repo, add that webhook URL with content type `application/json`, push events only and the same secret. Every push to a repo in `builds.json` now builds its images.

## Variables

| Variable | Meaning |
| --- | --- |
| `HATCHET_CLIENT_TOKEN` | Your Hatchet API token. |
| `SANDBOX_PROVIDER` | Provider name in Hatchet. `archil`. |
| `SANDBOX_TEMPLATE` | Sandbox image. `docker:28.3.3-dind`. |
| `SANDBOX_WORKDIR` | Same as the provider config. `/workspace`. |
| `SANDBOX_VCPU`, `SANDBOX_MEMORY` | Size of a new sandbox. |
| `IMAGE_PREFIX` | Where images go, such as `ghcr.io/<owner>`. |
| `REGISTRY_UPSTREAM` | Registry URL. `https://ghcr.io`. An ECR host uses your AWS credentials instead. |
| `REGISTRY_USER`, `REGISTRY_PASSWORD` | GitHub user and classic token. |
| `GITHUB_TOKEN` | Only for private repos. |
| `PROXY_PUBLIC_URL` | Set if you host the proxy yourself. Otherwise cloudflared opens a tunnel. |
| `SKIP_EXISTING` | `true` skips images whose tag already exists. Off by default. |
| `WEB_PORT` | Web UI port. `8788`. |
| `HATCHET_DASHBOARD_URL` | Where run links open. Found from your token by default. |
| `BUILDS_FILE` | Path of the repo list. `builds.json`. |

## Notes

The web UI has no login and listens on localhost only. Do not expose it without auth.

GHCR packages are private by default. Make them public in GitHub if you want others to pull.

A cloudflared tunnel caps one request at 100 MB. Host the proxy yourself for bigger layers.
