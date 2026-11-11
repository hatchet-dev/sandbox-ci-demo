# sandbox-ci-demo

Build and push Docker images with Hatchet sandboxes instead of GitHub Actions.

A push to GitHub starts a Hatchet task. The task opens a sandbox, runs `docker build` and `docker push` inside it, and streams the log back. The sandbox stays around between builds, so the Docker layer cache is always warm. A terminal UI lets you set up any number of repos and images and watch every layer build.

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

## What gets built

`builds.json` lists the repos and the images each one produces. The TUI edits this file for you, so you rarely touch it by hand.

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

Each image has a `name`, a `dockerfile` path and a build `context` inside the repo. `stage` picks a Dockerfile stage and `args` are build args. Both are optional. The pushed image is `<IMAGE_PREFIX>/<repo>-<name>:<sha>`, or `<IMAGE_PREFIX>/<repo>:<sha>` when the name is empty. Set `image` on an entry to use a full image path of your own instead.

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

Each repo is a tab. The form shows the repo url, the ref and one block per image. Press Enter in any field to build. The right side shows one pane per image with the pipeline phases, every build step, how many layers came from cache, and the pushed image with its digest.

| Key | Action |
| --- | --- |
| Enter | Build the current repo, or load the selected run back into the form. |
| Tab, arrows | Move between fields and down into the runs list. |
| ctrl+n | Next repo tab. |
| ctrl+t, ctrl+w | New repo tab, close the current tab. |
| ctrl+a, ctrl+x | Add an image after the current one, remove the current image. |

You can also build from the command line. The first form builds a repo from `builds.json` by name. The second builds any public repo with one image.

```sh
pnpm build -- --repo sandbox-ci-demo --ref main
pnpm build -- --repo https://github.com/owner/repo.git --dockerfile Dockerfile --context . --stage api --arg KEY=value
```

## Build on push

Create a webhook in Hatchet under Webhooks. Use the name `github`, the source GitHub, the event key expression `'github:' + headers['x-github-event']` and a secret of your choice.

Add the webhook URL to each GitHub repo under Settings, then Webhooks. Set the content type to `application/json`, choose push events only and use the same secret. Every push to a repo listed in `builds.json` now builds its images. Pushes to other repos are ignored.

## Variables

| Variable | Meaning |
| --- | --- |
| `HATCHET_CLIENT_TOKEN` | API token for your tenant. |
| `SANDBOX_PROVIDER` | Provider name in Hatchet. `archil` by default. |
| `SANDBOX_TEMPLATE` | Image the sandbox boots. `docker:28.3.3-dind` by default. |
| `SANDBOX_WORKDIR` | Must match the provider config. `/workspace` by default. |
| `SANDBOX_VCPU`, `SANDBOX_MEMORY` | Size of a new sandbox. |
| `IMAGE_PREFIX` | Registry namespace such as `ghcr.io/<owner>`. |
| `REGISTRY_UPSTREAM` | Registry the proxy pushes to. `https://ghcr.io` by default. An ECR host switches to ECR tokens from your AWS credentials. |
| `REGISTRY_USER`, `REGISTRY_PASSWORD` | Your GitHub user and classic token. Not used for ECR. |
| `GITHUB_TOKEN` | Only for private repos. |
| `PROXY_PUBLIC_URL` | Set this if you host the proxy yourself. Otherwise the worker opens a cloudflared tunnel. |
| `SKIP_EXISTING` | `true` skips a build when the tag is already in the registry. Off by default so a rebuild shows the warm cache. |
| `BUILDS_FILE` | Path of the repo list. `builds.json` by default. |

## Notes

GHCR packages are private by default. Make them public in the package settings on GitHub if you want others to pull them.

A cloudflared quick tunnel caps a single request at 100 MB. Run the proxy on a host of your own and set `PROXY_PUBLIC_URL` if a layer is bigger than that.
