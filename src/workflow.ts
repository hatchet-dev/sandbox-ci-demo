import type { Sandbox } from '@hatchet-dev/sandbox';
import { ConcurrencyLimitStrategy } from '@hatchet-dev/typescript-sdk/v1';
import { APP, CFG, hatchet, ok, q, repoName, repoSlug, sh } from './client.js';
import * as proxy from './proxy.js';

export type BuildSpec = { dockerfile: string; context: string; args: Record<string, string>; targets: string[]; targetArg: string };
export type PipelineInput = {
  ref: string;
  after?: string;
  deleted?: boolean;
  repository: { clone_url: string; full_name: string; default_branch?: string };
  build?: Partial<BuildSpec>;
};
export type BuildInput = { cloneUrl: string; repo: string; rev: string; target: string; name: string; spec: BuildSpec; topic: string };
export type BuildOutput = { name: string; target: string; image: string; digest: string; sha: string; cacheHit: boolean; seconds: number; skipped: boolean };
export type PipelineOutput = { branch: string; sha?: string; images: BuildOutput[]; skipped?: boolean };

const W = CFG.workdir;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const defaultSpec = (): BuildSpec => ({ dockerfile: CFG.dockerfile, context: CFG.context, args: {}, targets: CFG.targets, targetArg: CFG.targetArg });
export const publish = (topic: string, msg: Record<string, unknown>) => hatchet.streams.publish(topic, JSON.stringify(msg));
export const manualInput = (ref: string, repoUrl = CFG.repoUrl, build?: Partial<BuildSpec>): PipelineInput => ({
  ref,
  repository: { clone_url: repoUrl, full_name: repoSlug(repoUrl), default_branch: ref },
  ...(build ? { build } : {}),
});
export const runOpts = (repo: string, ref: string) => ({ additionalMetadata: { repo, ref } });

async function detach(sb: Sandbox, cmd: string) {
  const r = await sb.exec(`setsid sh -c ${q(cmd)} >/dev/null 2>&1 </dev/null & sleep 60`, { timeoutMs: 1000 });
  if (r.exitCode !== 124) throw new Error(`detach exited ${r.exitCode} instead of timing out\n${r.stderr || r.stdout}`);
}

export async function setup(sb: Sandbox) {
  ok('git', await sb.exec('command -v git >/dev/null || apk add -q --no-cache git', { timeoutMs: 120_000 }));
  if ((await sb.exec('docker info >/dev/null 2>&1', { timeoutMs: 30_000 })).exitCode === 0) return;
  await detach(sb, `dockerd --data-root ${W}/.docker >${W}/dockerd.log 2>&1`);
  ok('dockerd', await sb.exec(`for i in $(seq 90); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; tail -50 ${W}/dockerd.log; exit 1`, { timeoutMs: 120_000 }));
}

export const createOpts = (): NonNullable<Parameters<typeof hatchet.sandbox.create>[0]> => ({
  template: CFG.template,
  ...(CFG.provider ? { provider: CFG.provider } : {}),
  ...(CFG.vcpu || CFG.memory ? { resources: { ...(CFG.vcpu ? { vcpu: CFG.vcpu } : {}), ...(CFG.memory ? { memory: CFG.memory } : {}) } } : {}),
});

export async function runScript(sb: Sandbox, script: string, onChunk: (chunk: string) => void | Promise<void>, maxSeconds = 55 * 60): Promise<number> {
  await sb.files.write('build.sh', script);
  ok('reset', await sb.exec('rm -f build.log rc', { timeoutMs: 30_000 }));
  await detach(sb, 'sh build.sh >build.log 2>&1; echo $? > rc');
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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/, '');
const cacheMeta = (repo: string, target: string) => ({ app: APP, role: 'cache', repo: repo.replace(/\//g, '-'), ...(target ? { target } : {}) });
const cacheId = (repo: string, target: string) => slug(`ci-${repo}${target ? `-${target}` : ''}`).slice(0, 63).replace(/-+$/, '');
export const imageName = (repo: string, target: string) => `${CFG.imagePrefix}/${repoName(repo)}${target ? `-${slug(target)}` : ''}`;

export const buildImage = hatchet.task({
  name: 'build-image',
  retries: 1,
  executionTimeout: '60m',
  fn: async (input: BuildInput, ctx): Promise<BuildOutput> => {
    const started = Date.now();
    const say = (msg: Record<string, unknown>) => publish(input.topic, { name: input.name, ...msg });
    const seconds = () => Math.round((Date.now() - started) / 1000);
    const id = cacheId(input.repo, input.target);
    const [existing] = await hatchet.sandbox.list({ sandboxId: id });
    const sb = existing
      ? await hatchet.sandbox.connect(id, { template: CFG.template })
      : await hatchet.sandbox.create({ ...createOpts(), id, metadata: cacheMeta(input.repo, input.target) });
    const cacheHit = Boolean(existing);
    await say({ phase: 'sandbox', cacheHit, sandboxId: sb.sandboxId });
    const host = proxy.publicHost();
    const ott = proxy.mint();
    try {
      await setup(sb);
      const gitAuth = process.env.GITHUB_TOKEN
        ? `-c url."${proxy.publicOrigin()}/git/github.com/".insteadOf=https://github.com/ -c http.extraHeader="Authorization: Basic ${Buffer.from(`build:${ott}`).toString('base64')}"`
        : '';
      const sha = ok('checkout', await sb.exec(sh([
        `[ -d src/.git ] || git ${gitAuth} clone -q ${q(input.cloneUrl)} src`,
        `git -C src ${gitAuth} fetch -q origin`,
        `git -C src checkout -q --detach ${q(input.rev)}`,
        'git -C src rev-parse --short=12 HEAD',
      ]), { timeoutMs: 300_000 })).stdout.trim().split('\n').pop()!;
      await say({ phase: 'checkout', sha });
      const image = `${imageName(input.repo, input.target)}:${sha}`;
      const pushRef = `${host}/${image.replace(/^[^/]+\//, '')}`;
      ok('login', await sb.exec(`printf %s ${q(ott)} | docker login ${host} -u build --password-stdin`, { timeoutMs: 60_000 }));
      const exists = (await sb.exec(`docker manifest inspect ${pushRef} >/dev/null 2>&1`, { timeoutMs: 60_000 })).exitCode === 0;
      if (exists) {
        ctx.log(`${image} already exists, skipping`);
        const out = { name: input.name, target: input.target, image, digest: '', sha, cacheHit, seconds: seconds(), skipped: true };
        await say({ phase: 'done', ...out });
        return out;
      }
      ctx.log(`building ${image}`);
      await say({ phase: 'build' });
      const args = Object.entries(input.spec.args).map(([k, v]) => `--build-arg ${q(`${k}=${v}`)}`);
      if (input.target) args.push(`--build-arg ${q(`${input.spec.targetArg}=${input.target}`)}`);
      args.push(`--label ${q(`org.opencontainers.image.source=${input.cloneUrl.replace(/\.git$/, '')}`)}`);
      const rc = await runScript(sb, [
        'set -e',
        `docker build --progress=plain -f src/${q(input.spec.dockerfile)} ${args.join(' ')} -t ${pushRef} src/${q(input.spec.context)}`,
        `docker push ${pushRef}`,
        `docker inspect --format '{{index .RepoDigests 0}}' ${pushRef} | sed 's/.*@//' > digest`,
      ].join('\n'), (log) => say({ log }));
      if (rc !== 0) {
        const tail = (await sb.exec('tail -c 3000 build.log', { timeoutMs: 30_000 })).stdout;
        throw new Error(`build exited ${rc}\n${tail}`);
      }
      const digest = ok('digest', await sb.exec('cat digest', { timeoutMs: 30_000 })).stdout.trim();
      await sb.exec(`docker logout ${host}`, { timeoutMs: 30_000 });
      const out = { name: input.name, target: input.target, image, digest, sha, cacheHit, seconds: seconds(), skipped: false };
      ctx.log(`pushed ${image}@${digest} in ${out.seconds}s`);
      await say({ phase: 'done', ...out });
      return out;
    } finally {
      proxy.revoke(ott);
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
    const spec: BuildSpec = { ...defaultSpec(), ...Object.fromEntries(Object.entries(input.build ?? {}).filter(([, v]) => v !== undefined)) };
    const targets = spec.targets.length ? spec.targets : [''];
    const rev = input.after ?? `origin/${branch}`;
    await publish(topic, { phase: 'start', branch, rev, names: targets.map((t) => t || 'image') });
    const images = await ctx.bulkRunChildren<BuildInput, BuildOutput>(
      targets.map((target) => ({
        workflow: buildImage,
        input: { cloneUrl: input.repository.clone_url, repo: input.repository.full_name, rev, target, name: target || 'image', spec, topic },
        options: { additionalMetadata: { repo: input.repository.full_name, target: target || 'image', ref: branch } },
      }))
    );
    await publish(topic, { phase: 'end', images });
    return { branch, sha: images[0]?.sha, images };
  },
});
