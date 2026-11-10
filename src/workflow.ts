import type { Sandbox } from '@hatchet-dev/sandbox';
import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk/v1';
import { APP, CFG, hatchet, ok, repoSlug, sh } from './client.js';
import * as proxy from './proxy.js';

export type PipelineInput = {
  ref: string;
  after?: string;
  deleted?: boolean;
  repository: { clone_url: string; full_name: string; default_branch?: string };
};
export type BuildInput = { cloneUrl: string; repo: string; rev: string; service: string; isDefault: boolean; topic: string };
export type BuildOutput = { service: string; image: string; digest: string; sha: string; cacheHit: boolean; seconds: number; skipped: boolean };
export type PipelineOutput = { branch: string; sha?: string; images: BuildOutput[]; skipped?: boolean };

const W = CFG.workdir;
const SETUP = `command -v git >/dev/null || apk add -q --no-cache git; docker info >/dev/null 2>&1 || (nohup dockerd --data-root ${W}/.docker >${W}/dockerd.log 2>&1 </dev/null &); for i in $(seq 90); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; tail -50 ${W}/dockerd.log; exit 1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const setup = (sb: Sandbox) => sb.exec(SETUP, { timeoutMs: 240_000 });
export const publish = (topic: string, msg: Record<string, unknown>) => hatchet.streams.publish(topic, JSON.stringify(msg));
export const manualInput = (ref: string): PipelineInput => ({
  ref,
  repository: { clone_url: CFG.repoUrl, full_name: repoSlug(CFG.repoUrl), default_branch: CFG.defaultBranch },
});

export const createOpts = (from?: string): NonNullable<Parameters<typeof hatchet.sandbox.create>[0]> => ({
  template: CFG.template,
  ...(CFG.provider ? { provider: CFG.provider } : {}),
  ...(from
    ? { from }
    : CFG.vcpu || CFG.memory
      ? { resources: { ...(CFG.vcpu ? { vcpu: CFG.vcpu } : {}), ...(CFG.memory ? { memory: CFG.memory } : {}) } }
      : {}),
});

export async function runScript(sb: Sandbox, script: string, onChunk: (chunk: string) => void | Promise<void>, maxSeconds = 55 * 60): Promise<number> {
  await sb.files.write('build.sh', script);
  ok('start script', await sb.exec(`rm -f build.log rc; (nohup sh -c 'sh build.sh; echo $? > rc' >build.log 2>&1 </dev/null &)`, { timeoutMs: 30_000 }));
  const started = Date.now();
  let offset = 0;
  while (Date.now() - started < maxSeconds * 1000) {
    await sleep(3000);
    const r = await sb.exec(`tail -c +${offset + 1} build.log; printf '\\n__RC=%s\\n' "$(cat rc 2>/dev/null)"`, { timeoutMs: 30_000 });
    const m = /\n__RC=(\d*)\n$/.exec(r.stdout);
    if (!m) continue;
    const chunk = r.stdout.slice(0, m.index);
    if (chunk) {
      offset += Buffer.byteLength(chunk);
      await onChunk(chunk);
    }
    if (m[1]) return Number(m[1]);
  }
  throw new Error(`script still running after ${maxSeconds}s`);
}

const cacheMeta = (repo: string, service: string) => ({ app: APP, role: 'cache', repo: repo.replace(/\//g, '-'), service });

async function caches(repo: string, service: string) {
  const list = await hatchet.sandbox.list({ metadata: cacheMeta(repo, service) });
  return list.filter((s) => s.latestSnapshot).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export const buildImage = hatchet.task({
  name: 'build-image',
  retries: 1,
  executionTimeout: '60m',
  fn: async (input: BuildInput, ctx): Promise<BuildOutput> => {
    const started = Date.now();
    const say = (msg: Record<string, unknown>) => publish(input.topic, { service: input.service, ...msg });
    const seconds = () => Math.round((Date.now() - started) / 1000);
    const previous = await caches(input.repo, input.service);
    const from = previous[0]?.latestSnapshot;
    const sb = await hatchet.sandbox.create({
      ...createOpts(from),
      metadata: { ...cacheMeta(input.repo, input.service), rev: input.rev.replace(/\//g, '-').slice(0, 40) },
    });
    await say({ phase: 'sandbox', cacheHit: Boolean(from), sandboxId: sb.sandboxId });
    const host = proxy.publicHost();
    const ott = proxy.mint();
    let keep = false;
    try {
      ok('setup', await setup(sb));
      const gitAuth = process.env.GITHUB_TOKEN
        ? `-c url."${proxy.publicOrigin()}/git/github.com/".insteadOf=https://github.com/ -c http.extraHeader="Authorization: Basic ${Buffer.from(`build:${ott}`).toString('base64')}"`
        : '';
      const sha = ok('checkout', await sb.exec(sh([
        `[ -d src/.git ] || git ${gitAuth} clone -q ${input.cloneUrl} src`,
        `git -C src ${gitAuth} fetch -q origin`,
        `git -C src checkout -q --detach ${input.rev}`,
        'git -C src rev-parse --short=12 HEAD',
      ]), { timeoutMs: 300_000 })).stdout.trim().split('\n').pop()!;
      const image = `${CFG.imagePrefix}-${input.service}:${sha}`;
      const pushRef = `${host}/${image.replace(/^[^/]+\//, '')}`;
      ok('login', await sb.exec(`printf %s '${ott}' | docker login ${host} -u build --password-stdin`, { timeoutMs: 60_000 }));
      const exists = (await sb.exec(`docker manifest inspect ${pushRef} >/dev/null 2>&1`, { timeoutMs: 60_000 })).exitCode === 0;
      if (exists) {
        ctx.log(`${image} already exists, skipping`);
        const out = { service: input.service, image, digest: '', sha, cacheHit: Boolean(from), seconds: seconds(), skipped: true };
        await say({ phase: 'done', ...out });
        return out;
      }
      ctx.log(`building ${image}`);
      const rc = await runScript(sb, [
        'set -e',
        `docker build --progress=plain -f src/${CFG.dockerfile} --build-arg SERVER_TARGET=${input.service} -t ${pushRef} src`,
        `docker push ${pushRef}`,
        `docker inspect --format '{{index .RepoDigests 0}}' ${pushRef} | sed 's/.*@//' > digest`,
      ].join('\n'), (log) => say({ log }));
      if (rc !== 0) {
        const tail = (await sb.exec('tail -c 3000 build.log', { timeoutMs: 30_000 })).stdout;
        throw new Error(`build exited ${rc}\n${tail}`);
      }
      const digest = ok('digest', await sb.exec('cat digest', { timeoutMs: 30_000 })).stdout.trim();
      await sb.exec(`docker logout ${host}`, { timeoutMs: 30_000 });
      keep = input.isDefault;
      const out = { service: input.service, image, digest, sha, cacheHit: Boolean(from), seconds: seconds(), skipped: false };
      ctx.log(`pushed ${image}@${digest} in ${out.seconds}s`);
      await say({ phase: 'done', ...out });
      return out;
    } finally {
      proxy.revoke(ott);
      if (keep) {
        await sb.kill();
        for (const old of previous) await hatchet.sandbox.delete({ sandboxId: old.sandboxId });
      } else {
        await sb.delete();
      }
    }
  },
});

export const pipeline = hatchet.durableTask({
  name: 'image-pipeline',
  onEvents: ['github:push'],
  concurrency: [{ expression: 'input.repository.full_name', maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }],
  executionTimeout: '2h',
  fn: async (input: PipelineInput, ctx): Promise<PipelineOutput> => {
    const topic = `pipeline:${ctx.workflowRunId()}`;
    const branch = input.ref.replace(/^refs\/(heads|tags)\//, '');
    if (input.deleted) return { branch, images: [], skipped: true };
    const isDefault = branch === (input.repository.default_branch ?? CFG.defaultBranch);
    const rev = input.after ?? `origin/${branch}`;
    await publish(topic, { phase: 'start', branch, rev, services: CFG.services });
    const images = await ctx.bulkRunChildren<BuildInput, BuildOutput>(
      CFG.services.map((service) => ({
        workflow: buildImage,
        input: { cloneUrl: input.repository.clone_url, repo: input.repository.full_name, rev, service, isDefault, topic },
      }))
    );
    await publish(topic, { phase: 'end', images });
    return { branch, sha: images[0]?.sha, images };
  },
});
