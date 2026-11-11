import { CFG, findRepo, loadRepos, newRepo, type ImageSpec } from './client.js';
import { manualInput, pipeline, runOpts } from './workflow.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repos = loadRepos();
const key = flag('repo');
let repo = key ? findRepo(repos, key) : repos[0];
if (!repo && key?.includes('/')) {
  const args = argv.flatMap((a, i) => (a === '--arg' && argv[i + 1]?.includes('=') ? [argv[i + 1].split(/=(.*)/s).slice(0, 2) as [string, string]] : []));
  const img: ImageSpec = { name: flag('name') ?? '', dockerfile: flag('dockerfile') ?? 'Dockerfile', context: flag('context') ?? '.', args: Object.fromEntries(args) };
  if (flag('stage')) img.stage = flag('stage');
  repo = { ...newRepo(key), images: [img] };
}
if (!repo) throw new Error(`no repo ${key ?? ''} in ${CFG.buildsFile}; pass --repo <name> or --repo <url> --dockerfile … --context …`);

const ref = flag('ref') ?? repo.ref;
const input = manualInput(repo, ref, argv.includes('--skip-existing') || CFG.skipExisting);
console.log(`building ${repo.url} at ${ref}`);
const started = Date.now();
const result = await pipeline.run(input, runOpts(input.repository.full_name, ref));
for (const i of result.images) {
  console.log(`${i.name.padEnd(12)} ${i.skipped ? 'exists    ' : i.cacheHit ? 'cache hit ' : 'cache miss'} ${String(i.seconds).padStart(5)}s  ${i.image}${i.digest ? `@${i.digest}` : ''}`);
}
console.log(`wall ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(0);
