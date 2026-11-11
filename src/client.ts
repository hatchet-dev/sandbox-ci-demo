import { readFileSync, writeFileSync } from 'node:fs';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import '@hatchet-dev/sandbox';

process.env.HATCHET_SANDBOX_OTEL ??= 'false';

export const hatchet = HatchetClient.init();

export const CFG = {
  provider: process.env.SANDBOX_PROVIDER ?? '',
  template: process.env.SANDBOX_TEMPLATE ?? 'docker:28.3.3-dind',
  workdir: process.env.SANDBOX_WORKDIR ?? '/workspace',
  vcpu: Number(process.env.SANDBOX_VCPU ?? 0),
  memory: process.env.SANDBOX_MEMORY ?? '',
  registryUpstream: process.env.REGISTRY_UPSTREAM ?? 'https://ghcr.io',
  imagePrefix: process.env.IMAGE_PREFIX ?? '',
  skipExisting: process.env.SKIP_EXISTING === 'true',
  buildsFile: process.env.BUILDS_FILE ?? 'builds.json',
};
export const APP = 'image-ci';

export type ImageSpec = { name: string; dockerfile: string; context: string; stage?: string; args: Record<string, string>; image?: string };
export type RepoSpec = { url: string; ref: string; images: ImageSpec[] };

export const repoSlug = (url: string) =>
  url.replace(/^https?:\/\/[^/]+\//, '').replace(/^git@[^:]+:/, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
export const repoName = (slug: string) => slug.split('/').pop() || 'image';
export const newImage = (): ImageSpec => ({ name: '', dockerfile: 'Dockerfile', context: '.', args: {} });
export const newRepo = (url = ''): RepoSpec => ({ url, ref: 'main', images: [newImage()] });

export function loadRepos(): RepoSpec[] {
  try {
    return (JSON.parse(readFileSync(CFG.buildsFile, 'utf8')).repos ?? []) as RepoSpec[];
  } catch {
    return [];
  }
}
export const saveRepos = (repos: RepoSpec[]) => writeFileSync(CFG.buildsFile, JSON.stringify({ repos }, null, 2) + '\n');
export const findRepo = (repos: RepoSpec[], key: string) =>
  repos.find((r) => repoSlug(r.url) === repoSlug(key) || repoName(repoSlug(r.url)) === key.toLowerCase());

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
