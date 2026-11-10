import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { CFG, detail, hatchet } from './client.js';
import { manualInput, pipeline, type BuildOutput } from './workflow.js';

process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'OFF';

const C = { purple: '#7b6cff', lilac: '#b3a8ff', cyan: '#39d0ff', orange: '#ffb648', green: '#5ff59a', magenta: '#ff6ad5', red: '#ff5f6d', dim: '#5a5a7a', ink: '#e8e8ff' };
const LEFT = 58;
const STATUS: Record<string, [string, string]> = {
  QUEUED: ['○', C.dim], RUNNING: ['⟳', C.cyan], COMPLETED: ['●', C.green], FAILED: ['✗', C.red], CANCELLED: ['–', C.orange],
};

type Run = { id: string; status: string; createdAt: string; duration?: number; input: any; output: any };
type Pane = Partial<BuildOutput> & { lines: string[]; phase?: string };
type Msg = { service?: string; phase?: string; log?: string } & Partial<BuildOutput>;

const age = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const dur = (ms?: number) => (ms ? `${Math.round(ms / 1000)}s` : '');

const Frame = ({ title, meta, color, width, height, children }: { title: string; meta?: string; color: string; width: number; height?: number; children: React.ReactNode }) => {
  const head = ` ${title} `;
  const tail = meta ? ` ${meta} ` : '';
  const fill = Math.max(1, width - 4 - head.length - tail.length);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={color}>╭─<Text inverse bold>{head}</Text>{'─'.repeat(fill)}<Text color={C.dim}>{tail}</Text>─╮</Text>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={color} borderTop={false} paddingX={1}>{children}</Box>
    </Box>
  );
};

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 40;
  const cols = stdout.columns ?? 160;
  const right = Math.max(40, cols - LEFT);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState(0);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [note, setNote] = useState('');
  const selected = runs[sel];
  const selectedId = selected?.id;
  const abort = useRef<AbortController>();

  useEffect(() => {
    const poll = async () => {
      try {
        const { rows: list } = await hatchet.runs.list({ workflowNames: ['image-pipeline'], limit: 40, since: new Date(Date.now() - 7 * 86400_000) });
        const next = list
          .map((r) => ({ id: r.metadata.id, status: r.status, createdAt: r.createdAt, duration: r.duration, input: r.input as any, output: r.output as any }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRuns(next);
      } catch (e) {
        setNote(`list: ${detail(e)}`);
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    abort.current?.abort();
    setPanes({});
    if (!selectedId) return;
    const ac = new AbortController();
    abort.current = ac;
    void (async () => {
      try {
        for await (const ev of hatchet.streams.subscribe(`pipeline:${selectedId}`, { signal: ac.signal })) {
          const msg = JSON.parse(new TextDecoder().decode(ev.payload)) as Msg;
          if (!msg.service) continue;
          const { service, log, ...rest } = msg;
          setPanes((p) => {
            const pane = p[service] ?? { lines: [] };
            const lines = log ? [...pane.lines, ...log.split('\n').filter(Boolean)].slice(-400) : pane.lines;
            return { ...p, [service]: { ...pane, ...rest, lines } };
          });
        }
      } catch (e) {
        if (!ac.signal.aborted) setNote(`stream: ${detail(e)}`);
      }
    })();
    return () => ac.abort();
  }, [selectedId]);

  useInput((ch, key) => {
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setSel((i) => Math.min(runs.length - 1, i + 1));
    if (ch === 'q') exit();
    if (ch === 'b') {
      setNote(`triggering build of ${CFG.defaultBranch}`);
      pipeline.runNoWait(manualInput(CFG.defaultBranch)).then(() => setNote('build queued'), (e) => setNote(`trigger: ${detail(e)}`));
    }
  });

  const paneHeight = Math.max(6, Math.floor((rows - 3) / CFG.services.length));
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1}>
        <Frame title="RUNS" meta={`${runs.length}`} color={C.purple} width={LEFT}>
          {runs.slice(0, rows - 5).map((r, i) => {
            const [glyph, color] = STATUS[r.status] ?? ['?', C.dim];
            const branch = String(r.input?.ref ?? '').replace(/^refs\/(heads|tags)\//, '');
            const sha = String(r.output?.sha ?? r.input?.after ?? '').slice(0, 12);
            return (
              <Text key={r.id} inverse={i === sel}>
                <Text color={color}>{glyph}</Text> {age(r.createdAt).padStart(4)} <Text color={C.lilac}>{branch.padEnd(16).slice(0, 16)}</Text> <Text color={C.cyan}>{sha.padEnd(12)}</Text> <Text color={C.dim}>{dur(r.duration).padStart(6)}</Text>
              </Text>
            );
          })}
          {runs.length === 0 && <Text color={C.dim}>no runs yet, press b</Text>}
        </Frame>
        <Box flexDirection="column" width={right}>
          {CFG.services.map((service) => {
            const p = panes[service];
            const meta = p ? [p.phase === 'done' ? (p.skipped ? 'exists' : `pushed ${p.seconds}s`) : 'building', p.cacheHit === undefined ? '' : p.cacheHit ? 'cache hit' : 'cache miss'].filter(Boolean).join(' · ') : '';
            const color = p?.phase === 'done' ? C.green : p ? C.cyan : C.dim;
            return (
              <Frame key={service} title={service} meta={meta} color={color} width={right} height={paneHeight}>
                {(p?.lines ?? []).slice(-(paneHeight - 3)).map((l, i) => <Text key={i} color={C.ink}>{l.slice(0, right - 4)}</Text>)}
                {p?.image && <Text color={C.lilac}>{p.image}{p.digest ? `@${p.digest.slice(0, 19)}` : ''}</Text>}
              </Frame>
            );
          })}
        </Box>
      </Box>
      <Text><Text backgroundColor={C.purple} color="black" bold> ↑↓ </Text><Text color={C.dim}> run  </Text><Text backgroundColor={C.purple} color="black" bold> b </Text><Text color={C.dim}> build {CFG.defaultBranch}  </Text><Text backgroundColor={C.purple} color="black" bold> q </Text><Text color={C.dim}> quit   </Text><Text color={C.orange}>{note}</Text></Text>
    </Box>
  );
}

render(<App />);
