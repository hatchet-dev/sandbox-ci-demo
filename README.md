# sandboxes-tui-demo

Build and push Docker images with Hatchet sandboxes instead of GitHub Actions.

A push to GitHub starts a Hatchet task. The task opens a sandbox, runs `docker build` and `docker push` inside it, and streams the log back. The sandbox stays around between builds, so the Docker layer cache is always warm. A terminal UI lets you build any public repo and watch each step.

The sandbox never sees your registry password or GitHub token. The worker runs a small proxy that swaps a one-time token for the real credential.

## What you need

- A Hatchet Cloud tenant with the Sandboxes and Durable Streams labs previews turned on.
- An Archil account on the Developer plan or higher.
- A GitHub account and a classic personal access token with the `write:packages` scope.
- Node 24, pnpm and cloudflared on your machine.

```sh
brew install cloudflared
```

## Setup

1. In Hatchet, go to Settings, then Sandboxes, and connect a provider named `archil` with your Archil API key and this config.

   ```json
   {"region":"aws-us-east-1","workdir":"/workspace"}
   ```

2. Copy the env file and fill it in. Each variable is explained below.

   ```sh
   cp .env.example .env
   ```

3. Install.

   ```sh
   pnpm install
   ```

## Run

Load the env file in every terminal you use.

```sh
set -a && . ./.env && set +a
```

Check that Docker works in the sandbox and that the cache survives. This builds the sample app twice and fails if the second build is not cached.

```sh
pnpm probe
```

Start the worker. It prints the proxy URL once the tunnel is up.

```sh
pnpm worker
```

Open the terminal UI in a second terminal.

```sh
pnpm tui
```

Fill in the form at the top left and press Enter. Any public git repo with a Dockerfile works. Tab moves between fields and down to the list of runs. Each image gets a pane on the right that shows the pipeline phases, every build step, and the pushed image with its digest.

You can also build from the command line.

```sh
pnpm build -- --ref main
pnpm build -- --repo https://github.com/owner/repo.git --ref main --dockerfile Dockerfile --context . --targets ''
```

## Build on push

Create a webhook in Hatchet under Webhooks. Use the name `github`, the source GitHub, the event key expression `'github:' + headers['x-github-event']` and a secret of your choice.

Add the webhook URL to your GitHub repo under Settings, then Webhooks. Set the content type to `application/json`, choose push events only and use the same secret. Every push now builds the images in `REPO_URL`.

## Variables

| Variable | Meaning |
| --- | --- |
| `HATCHET_CLIENT_TOKEN` | API token for your tenant. |
| `SANDBOX_PROVIDER` | Provider name in Hatchet. `archil` by default. |
| `SANDBOX_TEMPLATE` | Image the sandbox boots. `docker:28.3.3-dind` by default. |
| `SANDBOX_WORKDIR` | Must match the provider config. `/workspace` by default. |
| `SANDBOX_VCPU`, `SANDBOX_MEMORY` | Size of a new sandbox. |
| `REPO_URL`, `DEFAULT_BRANCH` | Repo and branch to build when a push arrives or when you run `pnpm build` with no flags. |
| `DOCKERFILE`, `BUILD_CONTEXT` | Dockerfile path and build context inside the repo. |
| `SERVICES`, `TARGET_ARG` | Build one image per value in `SERVICES`, passing each value as the `TARGET_ARG` build arg. Leave `SERVICES` empty for a single image. |
| `IMAGE_PREFIX` | Registry namespace such as `ghcr.io/<owner>`. Images are named `<prefix>/<repo>-<target>:<sha>`. |
| `REGISTRY_UPSTREAM` | Registry the proxy pushes to. `https://ghcr.io` by default. An ECR host switches to ECR tokens from your AWS credentials. |
| `REGISTRY_USER`, `REGISTRY_PASSWORD` | Your GitHub user and classic token. Not used for ECR. |
| `GITHUB_TOKEN` | Only for private repos. |
| `PROXY_PUBLIC_URL` | Set this if you host the proxy yourself. Otherwise the worker opens a cloudflared tunnel. |
