import { CFG } from './client.js';
import { manualInput, pipeline, runOpts, type BuildSpec } from './workflow.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repo = flag('repo') ?? CFG.repoUrl;
const ref = flag('ref') ?? CFG.defaultBranch;
const build: Partial<BuildSpec> = {
  ...(flag('dockerfile') ? { dockerfile: flag('dockerfile') } : {}),
  ...(flag('context') ? { context: flag('context') } : {}),
  ...(flag('targets') !== undefined ? { targets: flag('targets')!.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  ...(flag('target-arg') ? { targetArg: flag('target-arg') } : {}),
};
const args = argv.flatMap((a, i) => (a === '--arg' && argv[i + 1]?.includes('=') ? [argv[i + 1].split(/=(.*)/s).slice(0, 2) as [string, string]] : []));
if (args.length) build.args = Object.fromEntries(args);

const input = manualInput(ref, repo, build);
console.log(`building ${repo} at ${ref}`);
const started = Date.now();
const result = await pipeline.run(input, runOpts(input.repository.full_name, ref));
for (const i of result.images) {
  console.log(`${i.name.padEnd(12)} ${i.skipped ? 'exists    ' : i.cacheHit ? 'cache hit ' : 'cache miss'} ${String(i.seconds).padStart(5)}s  ${i.image}${i.digest ? `@${i.digest}` : ''}`);
}
console.log(`wall ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(0);
