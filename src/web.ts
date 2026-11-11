import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CFG, detail, hatchet, loadRepos, saveRepos, type RepoSpec } from './client.js';
import { manualInput, pipeline, runOpts } from './workflow.js';

const PAGE = new URL('../web/index.html', import.meta.url);

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const dashboard = () => {
  if (process.env.HATCHET_DASHBOARD_URL) return process.env.HATCHET_DASHBOARD_URL.replace(/\/$/, '');
  const api = new URL(hatchet.config.api_url);
  return api.hostname.endsWith('.onhatchet.run') ? 'https://cloud.onhatchet.run' : api.origin;
};

type Detail = { repo?: string; cloneUrl?: string; ref?: string; sha?: string; images?: number; final: boolean };
const details = new Map<string, Detail>();

async function enrich(id: string, status: string): Promise<Detail> {
  const d = await hatchet.runs.get(id);
  const input = d.run?.input as any;
  const output = d.run?.output as any;
  const e: Detail = {
    repo: input?.repository?.full_name, cloneUrl: input?.repository?.clone_url, ref: String(input?.ref ?? '').replace(/^refs\/(heads|tags)\//, ''),
    sha: output?.sha ?? input?.after, images: output?.images?.length, final: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status),
  };
  details.set(id, e);
  return e;
}

async function events(id: string, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const beat = setInterval(() => res.write(':\n\n'), 15_000);
  try {
    for await (const ev of hatchet.streams.subscribe(`pipeline:${id}`, { signal: ac.signal })) {
      res.write(`data: ${JSON.stringify({ at: ev.createdAt?.getTime() ?? Date.now(), msg: JSON.parse(new TextDecoder().decode(ev.payload)) })}\n\n`);
    }
  } catch (e) {
    if (!ac.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify(detail(e))}\n\n`);
  } finally {
    clearInterval(beat);
    res.end();
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (p === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(PAGE));
  }
  if (p === '/api/repos' && req.method === 'GET') return json(res, 200, { repos: loadRepos(), imagePrefix: CFG.imagePrefix, skipExisting: CFG.skipExisting, runUrl: `${dashboard()}/tenants/${hatchet.tenantId}/runs/` });
  if (p === '/api/repos' && req.method === 'PUT') {
    saveRepos(((await body(req)).repos ?? []) as RepoSpec[]);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/build' && req.method === 'POST') {
    const b = await body(req);
    const repo = b.repo as RepoSpec;
    if (!repo?.url) return json(res, 400, { error: 'repo url is empty' });
    const input = manualInput(repo, b.ref || repo.ref, Boolean(b.skipExisting));
    const ref = await pipeline.runNoWait(input, runOpts(input.repository.full_name, input.ref));
    return json(res, 200, { id: await ref.getWorkflowRunId() });
  }
  if (p === '/api/runs' && req.method === 'GET') {
    const { rows } = await hatchet.runs.list({ workflowNames: ['image-pipeline'], limit: 100, since: new Date(Date.now() - 7 * 86400_000) });
    await Promise.all(rows.filter((r) => !details.get(r.metadata.id)?.final).slice(0, 10).map((r) => enrich(r.metadata.id, r.status).catch(() => undefined)));
    return json(res, 200, rows.map((r) => ({
      id: r.metadata.id, status: r.status, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, duration: r.duration,
      meta: r.additionalMetadata ?? {}, ...details.get(r.metadata.id),
    })));
  }
  const m = /^\/api\/runs\/([0-9a-f-]{36})(\/events)?$/.exec(p);
  if (m && req.method === 'GET') {
    if (m[2]) return events(m[1], req, res);
    const d = await hatchet.runs.get(m[1]);
    return json(res, 200, { input: d.run?.input, output: d.run?.output, status: d.run?.status, errorMessage: d.run?.errorMessage });
  }
  json(res, 404, { error: 'not found' });
}

export function start(port = Number(process.env.WEB_PORT ?? 8788)) {
  return new Promise<string>((resolve) => {
    createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: detail(e) }))).listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
  });
}
