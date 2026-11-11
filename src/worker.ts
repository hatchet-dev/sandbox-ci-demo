import { CFG, hatchet } from './client.js';
import * as proxy from './proxy.js';
import * as web from './web.js';
import { buildImage, pipeline } from './workflow.js';

if (!CFG.imagePrefix) throw new Error('IMAGE_PREFIX must be set');

console.log(`credential proxy at ${await proxy.start()}`);
console.log(`web ui at ${await web.start()}`);
const worker = await hatchet.worker('image-ci-worker', { workflows: [pipeline, buildImage], slots: 8 });
await worker.start();
