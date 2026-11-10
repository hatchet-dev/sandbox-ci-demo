import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, hatchet, ok } from './client.js';
import { createOpts, runScript, setup } from './workflow.js';

const SAMPLE = fileURLToPath(new URL('../sample/', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(SAMPLE).map((p) => ({ path: `sample/${relative(SAMPLE, p)}`, data: readFileSync(p) }));
const BUILD = 'docker build --progress=plain --build-arg SERVER_TARGET=api -t probe:1 -f sample/Dockerfile sample';

async function build(label: string, from?: string) {
  const sb = await hatchet.sandbox.create({ ...createOpts(from), metadata: { app: APP, role: 'probe' } });
  console.log(`${label}: sandbox ${sb.sandboxId}`);
  const started = Date.now();
  ok('setup', await setup(sb));
  console.log(`${label}: dockerd up in ${Math.round((Date.now() - started) / 1000)}s, ${ok('info', await sb.exec("id -un; docker info -f '{{.Driver}} {{.DockerRootDir}}'", { timeoutMs: 30_000 })).stdout.trim().replace('\n', ' ')}`);
  await sb.files.write(files);
  const t = Date.now();
  let out = '';
  const rc = await runScript(sb, BUILD, (c) => { out += c; }, 15 * 60);
  if (rc !== 0) throw new Error(`${label}: build exited ${rc}\n${out.slice(-3000)}`);
  const seconds = Math.round((Date.now() - t) / 1000);
  console.log(`${label}: build ${seconds}s, ${(out.match(/CACHED/g) ?? []).length} cached steps`);
  return { sb, seconds, cached: /CACHED/.test(out) };
}

const cold = await build('cold');
await cold.sb.kill();
const [info] = await hatchet.sandbox.list({ sandboxId: cold.sb.sandboxId });
if (!info?.latestSnapshot) throw new Error('no snapshot after kill');
console.log(`snapshot ${info.latestSnapshot}`);
const warm = await build('warm', info.latestSnapshot);
await warm.sb.delete();
await hatchet.sandbox.delete({ sandboxId: cold.sb.sandboxId });
console.log(`cold ${cold.seconds}s, warm ${warm.seconds}s, layer cache survived fork: ${warm.cached}`);
process.exit(warm.cached ? 0 : 1);
