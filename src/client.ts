import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import '@hatchet-dev/sandbox';

process.env.HATCHET_SANDBOX_OTEL ??= 'false';

export const hatchet = HatchetClient.init();

const list = (v: string | undefined, d: string) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export const CFG = {
  provider: process.env.SANDBOX_PROVIDER ?? '',
  template: process.env.SANDBOX_TEMPLATE ?? 'docker:28.3.3-dind',
  workdir: process.env.SANDBOX_WORKDIR ?? '/workspace',
  vcpu: Number(process.env.SANDBOX_VCPU ?? 0),
  memory: process.env.SANDBOX_MEMORY ?? '',
  repoUrl: process.env.REPO_URL ?? '',
  defaultBranch: process.env.DEFAULT_BRANCH ?? 'main',
  targets: list(process.env.SERVICES, 'api,worker'),
  targetArg: process.env.TARGET_ARG ?? 'SERVER_TARGET',
  dockerfile: process.env.DOCKERFILE ?? 'sample/Dockerfile',
  context: process.env.BUILD_CONTEXT ?? 'sample',
  registryUpstream: process.env.REGISTRY_UPSTREAM ?? 'https://ghcr.io',
  imagePrefix: process.env.IMAGE_PREFIX ?? '',
};

export const APP = 'image-ci';

export const repoSlug = (url: string) =>
  url.replace(/^https?:\/\/[^/]+\//, '').replace(/^git@[^:]+:/, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
export const repoName = (slug: string) => slug.split('/').pop() || 'image';

export const sh = (parts: string[]) => parts.join(' && ');
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function detail(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (Array.isArray(e)) return e.map(detail).join('; ');
  if (typeof e === 'string') return e;
  return JSON.stringify(e);
}

export function ok(step: string, r: { exitCode: number; stderr: string; stdout: string }) {
  if (r.exitCode !== 0) throw new Error(`${step} exited ${r.exitCode}\n${(r.stderr || r.stdout).slice(-2000)}`);
  return r;
}
