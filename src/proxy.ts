import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

const TTL_MS = 2 * 60 * 60 * 1000;
const tokens = new Map<string, number>();
let publicUrl = '';
const upstream = new URL(process.env.REGISTRY_UPSTREAM ?? 'https://ghcr.io');

export const mint = () => {
  const t = randomBytes(24).toString('base64url');
  tokens.set(t, Date.now() + TTL_MS);
  return t;
};
export const revoke = (t: string) => tokens.delete(t);
export const publicHost = () => new URL(publicUrl).host;
export const publicOrigin = () => publicUrl;

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function ottFrom(auth?: string): string | undefined {
  if (!auth?.startsWith('Basic ')) return undefined;
  const [user, ...rest] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  return user === 'build' ? rest.join(':') : undefined;
}

let ecr: { header: string; expires: number } | undefined;
async function registryCredential(): Promise<string> {
  if (!/\.dkr\.ecr\.[^.]+\.amazonaws\.com$/.test(upstream.host)) {
    return basic(process.env.REGISTRY_USER ?? '', process.env.REGISTRY_PASSWORD ?? '');
  }
  if (ecr && ecr.expires > Date.now()) return ecr.header;
  const { ECRClient, GetAuthorizationTokenCommand } = await import('@aws-sdk/client-ecr');
  const region = upstream.host.split('.')[3];
  const out = await new ECRClient({ region }).send(new GetAuthorizationTokenCommand({}));
  const data = out.authorizationData?.[0];
  if (!data?.authorizationToken) throw new Error('ecr: no authorization token');
  ecr = { header: `Basic ${data.authorizationToken}`, expires: (data.expiresAt?.getTime() ?? Date.now() + 11 * 3600_000) - 300_000 };
  return ecr.header;
}

type Route = { target: URL; credential: () => Promise<string> };

function route(url: URL): Route | undefined {
  if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
    return { target: new URL(url.pathname + url.search, upstream), credential: registryCredential };
  }
  const m = /^\/(_auth|git)\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (!m) return undefined;
  const target = new URL(`https://${m[2]}${m[3]}${url.search}`);
  if (m[1] === '_auth') return { target, credential: registryCredential };
  return { target, credential: async () => basic('x-access-token', process.env.GITHUB_TOKEN ?? '') };
}

const rewriteLocation = (v: string) => {
  if (!/^https?:\/\//.test(v)) return v;
  const u = new URL(v);
  return u.host === upstream.host ? `${publicUrl}${u.pathname}${u.search}` : v;
};
const rewriteChallenge = (v: string) => v.replace(/realm="https:\/\/([^/"]+)([^"]*)"/, (_, h, p) => `realm="${publicUrl}/_auth/${h}${p}"`);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://proxy');
  const r = route(url);
  if (!r) {
    res.writeHead(404).end();
    return;
  }
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !['host', 'connection'].includes(k)) headers[k] = v;
  const ott = ottFrom(req.headers.authorization);
  if (ott !== undefined) {
    if ((tokens.get(ott) ?? 0) < Date.now()) {
      res.writeHead(401).end();
      return;
    }
    headers.authorization = await r.credential();
  }
  headers.host = r.target.host;
  const mk = r.target.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = mk(r.target, { method: req.method, headers }, (ures) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(ures.headers)) {
      if (v === undefined) continue;
      if (k === 'location') out[k] = rewriteLocation(String(v));
      else if (k === 'www-authenticate') out[k] = rewriteChallenge(String(v));
      else out[k] = v;
    }
    res.writeHead(ures.statusCode ?? 502, out);
    ures.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(e.message);
  });
  req.pipe(up);
}

function quickTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('cloudflared did not print a tunnel URL within 60s')), 60_000);
    let buf = '';
    p.stderr.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    p.on('error', (e) => reject(new Error(`cloudflared: ${e.message}. Install it or set PROXY_PUBLIC_URL`)));
    p.on('exit', (code) => reject(new Error(`cloudflared exited ${code}\n${buf.slice(-1000)}`)));
    process.on('exit', () => p.kill());
  });
}

export async function start(port = Number(process.env.PROXY_PORT ?? 8787)): Promise<string> {
  await new Promise<void>((res) => createServer((q, s) => void handle(q, s)).listen(port, '127.0.0.1', res));
  // ponytail: quick tunnel caps a request body at 100 MB, so a layer above that fails to push. Run the proxy on a host and set PROXY_PUBLIC_URL for real images.
  publicUrl = (process.env.PROXY_PUBLIC_URL || (await quickTunnel(port))).replace(/\/$/, '');
  return publicUrl;
}
