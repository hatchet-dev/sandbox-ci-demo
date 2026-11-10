import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sandbox } from '@hatchet-dev/sandbox';
import { APP, CFG, hatchet, ok } from './client.js';
import { createOpts, runScript, setup } from './workflow.js';

const SAMPLE = fileURLToPath(new URL('../sample/', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(SAMPLE).map((p) => ({ path: `sample/${relative(SAMPLE, p)}`, data: readFileSync(p) }));
const BUILD = 'docker build --progress=plain --build-arg SERVER_TARGET=api -t probe:1 -f sample/Dockerfile sample';

async function build(label: string, sb: Sandbox) {
  const started = Date.now();
  await setup(sb);
  console.log(`${label}: dockerd up in ${Math.round((Date.now() - started) / 1000)}s, ${ok('info', await sb.exec("id -un; docker info -f '{{.Driver}} {{.DockerRootDir}}'", { timeoutMs: 30_000 })).stdout.trim().replace('\n', ' ')}`);
  await sb.files.write(files);
  const t = Date.now();
  let out = '';
  const rc = await runScript(sb, BUILD, (c) => { out += c; }, 15 * 60);
  if (rc !== 0) throw new Error(`${label}: build exited ${rc}\n${out.slice(-3000)}`);
  const seconds = Math.round((Date.now() - t) / 1000);
  console.log(`${label}: build ${seconds}s, ${(out.match(/CACHED/g) ?? []).length} cached steps`);
  return { seconds, cached: /CACHED/.test(out) };
}

for (const id of await hatchet.sandbox.delete({ metadata: { app: APP, role: 'probe' } })) console.log(`deleted leftover ${id}`);
const sb = await hatchet.sandbox.create({ ...createOpts(), metadata: { app: APP, role: 'probe' } });
console.log(`sandbox ${sb.sandboxId}`);
const cold = await build('cold', sb);
const again = await hatchet.sandbox.connect(sb.sandboxId, { template: CFG.template });
const warm = await build('warm', again);
await again.delete();
console.log(`cold ${cold.seconds}s, warm ${warm.seconds}s, layer cache on reconnect: ${warm.cached}`);
process.exit(warm.cached ? 0 : 1);
