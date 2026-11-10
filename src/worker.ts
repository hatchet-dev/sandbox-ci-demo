import { CFG, hatchet } from './client.js';
import * as proxy from './proxy.js';
import { buildImage, pipeline } from './workflow.js';

if (!CFG.repoUrl || !CFG.imagePrefix) throw new Error('REPO_URL and IMAGE_PREFIX must be set');

console.log(`credential proxy at ${await proxy.start()}`);
const worker = await hatchet.worker('image-ci-worker', { workflows: [pipeline, buildImage], slots: 8 });
await worker.start();
