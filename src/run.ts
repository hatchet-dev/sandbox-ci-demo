import { CFG } from './client.js';
import { manualInput, pipeline } from './workflow.js';

const ref = process.argv[process.argv.indexOf('--ref') + 1] || CFG.defaultBranch;
console.log(`building ${CFG.repoUrl} at ${ref} for ${CFG.services.join(', ')}`);
const started = Date.now();
const result = await pipeline.run(manualInput(ref));
for (const i of result.images) {
  console.log(`${i.service.padEnd(10)} ${i.skipped ? 'exists' : i.cacheHit ? 'cache hit ' : 'cache miss'} ${String(i.seconds).padStart(5)}s  ${i.image}${i.digest ? `@${i.digest}` : ''}`);
}
console.log(`wall ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(0);
