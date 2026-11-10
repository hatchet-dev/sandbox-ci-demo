import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { CFG, detail, hatchet, repoName } from './client.js';
import { manualInput, pipeline, runOpts, type BuildOutput } from './workflow.js';

process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'OFF';

const C = { purple: '#7b6cff', lilac: '#b3a8ff', cyan: '#39d0ff', orange: '#ffb648', green: '#5ff59a', magenta: '#ff6ad5', red: '#ff5f6d', dim: '#5a5a7a', ink: '#e8e8ff' };
const LEFT = 60;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS: Record<string, [string, string]> = {
  QUEUED: ['○', C.dim], RUNNING: ['⟳', C.cyan], COMPLETED: ['●', C.green], FAILED: ['✗', C.red], CANCELLED: ['–', C.orange],
};
const PHASES = ['sandbox', 'checkout', 'build', 'push', 'done'];
const FIELDS = [
  { key: 'repo', label: 'repo', placeholder: 'https://github.com/owner/repo.git' },
  { key: 'ref', label: 'ref', placeholder: 'main' },
  { key: 'dockerfile', label: 'dockerfile', placeholder: 'Dockerfile' },
  { key: 'context', label: 'context', placeholder: '.' },
  { key: 'targets', label: `targets (${CFG.targetArg})`, placeholder: 'api,worker or empty for one image' },
  { key: 'args', label: 'build args', placeholder: 'KEY=value KEY2=value' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

type Run = { id: string; status: string; createdAt: string; startedAt?: string; finishedAt?: string; duration?: number; input: any; output: any; meta: Record<string, string>; displayName: string };
type Step = { id: number; label: string; state: 'running' | 'done' | 'cached' | 'error' | 'canceled'; dur?: string };
type Pane = Partial<BuildOutput> & { steps: Map<number, Step>; tail: string[]; phase: number; startedAt: number; endedAt?: number; failed?: boolean };
type Msg = { name?: string; phase?: string; log?: string; names?: string[] } & Partial<BuildOutput>;

const age = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
const newPane = (at: number): Pane => ({ steps: new Map(), tail: [], phase: -1, startedAt: at });

function applyLine(pane: Pane, line: string) {
  if (line.startsWith('The push refers to')) pane.phase = Math.max(pane.phase, PHASES.indexOf('push'));
  const m = /^#(\d+) (.*)$/.exec(line);
  if (!m) return;
  const id = Number(m[1]);
  const rest = m[2];
  const step = pane.steps.get(id) ?? { id, label: '', state: 'running' as const };
  if (rest.startsWith('[')) step.label = rest;
  else if (rest.startsWith('DONE')) Object.assign(step, { state: 'done', dur: rest.slice(5) });
  else if (rest === 'CACHED') step.state = 'cached';
  else if (rest.startsWith('ERROR')) step.state = 'error';
  else if (rest.startsWith('CANCELED')) step.state = 'canceled';
  pane.steps.set(id, step);
}

function reduce(panes: Record<string, Pane>, msg: Msg, at: number): Record<string, Pane> {
  if (msg.phase === 'start' && msg.names) {
    return Object.fromEntries(msg.names.map((n) => [n, panes[n] ?? newPane(at)]));
  }
  if (!msg.name) return panes;
  const { name, log, phase, ...rest } = msg;
  const pane: Pane = { ...(panes[name] ?? newPane(at)), steps: new Map(panes[name]?.steps ?? []), tail: [...(panes[name]?.tail ?? [])] };
  if (log) {
    for (const line of log.split('\n')) {
      if (!line) continue;
      applyLine(pane, line);
      pane.tail = [...pane.tail, line].slice(-50);
    }
  }
  if (phase) pane.phase = Math.max(pane.phase, PHASES.indexOf(phase));
  if (phase === 'done') pane.endedAt = at;
  Object.assign(pane, rest);
  return { ...panes, [name]: pane };
}

const Frame = ({ title, meta, color, width, height, children }: { title: string; meta?: string; color: string; width: number; height?: number; children: React.ReactNode }) => {
  const head = ` ${title} `;
  const tail = meta ? ` ${meta} ` : '';
  const fill = Math.max(1, width - 4 - head.length - tail.length);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={color}>╭─<Text inverse bold>{head}</Text>{'─'.repeat(fill)}<Text color={C.dim}>{tail}</Text>─╮</Text>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={color} borderTop={false} paddingX={1} overflow="hidden">{children}</Box>
    </Box>
  );
};

const Key = ({ k, label }: { k: string; label: string }) => (
  <Text><Text backgroundColor={C.purple} color="black" bold>{` ${k} `}</Text><Text color={C.dim}> {label}  </Text></Text>
);

function BuildPane({ name, pane, width, height, tick, run }: { name: string; pane?: Pane; width: number; height: number; tick: number; run?: Run }) {
  const spin = SPIN[tick % SPIN.length];
  const runEnded = run?.finishedAt ? new Date(run.finishedAt).getTime() : undefined;
  const done = pane?.phase === PHASES.length - 1;
  const ended = done || runEnded !== undefined;
  const failed = pane?.failed || (ended && !done && run?.status !== 'COMPLETED');
  const color = failed ? C.red : done ? C.green : ended ? C.orange : pane ? C.cyan : C.dim;
  const elapsed = pane ? secs((pane.endedAt ?? runEnded ?? Date.now()) - pane.startedAt) : '';
  const meta = pane ? [pane.skipped ? 'exists' : pane.cacheHit === undefined ? '' : pane.cacheHit ? 'warm sandbox' : 'cold sandbox', elapsed].filter(Boolean).join(' · ') : 'waiting';
  const steps = [...(pane?.steps.values() ?? [])].sort((a, b) => a.id - b.id).filter((s) => s.label);
  const stepRows = Math.max(0, height - 8);
  const shown = steps.slice(-stepRows);
  const stepGlyph = (s: Step) =>
    s.state === 'running' ? <Text color={C.cyan}>{spin}</Text>
    : s.state === 'done' ? <Text color={C.green}>●</Text>
    : s.state === 'cached' ? <Text color={C.lilac}>◍</Text>
    : s.state === 'error' ? <Text color={C.red}>✗</Text>
    : <Text color={C.dim}>–</Text>;
  return (
    <Frame title={name} meta={meta} color={color} width={width} height={height}>
      <Text>
        {PHASES.map((p, i) => {
          const reached = (pane?.phase ?? -1) >= i;
          const current = (pane?.phase ?? -1) === i && !ended;
          return (
            <Text key={p}>
              <Text color={current ? C.cyan : reached ? C.green : C.dim}>{current ? spin : reached ? '●' : '○'} {p}</Text>
              {i < PHASES.length - 1 && <Text color={C.dim}> ── </Text>}
            </Text>
          );
        })}
      </Text>
      <Text> </Text>
      {shown.map((s) => (
        <Text key={s.id}>
          {stepGlyph(s)} <Text color={s.label.startsWith('[internal]') ? C.dim : C.ink}>{s.label.slice(0, width - 14)}</Text>
          <Text color={C.dim}>{s.dur ? ` ${s.dur}` : s.state === 'cached' ? ' cached' : ''}</Text>
        </Text>
      ))}
      {steps.length > shown.length && <Text color={C.dim}>… {steps.length - shown.length} earlier steps</Text>}
      <Box flexGrow={1} />
      {pane?.image && <Text color={C.lilac}>{pane.image}{pane.digest ? <Text color={C.dim}>@{pane.digest.slice(0, 19)}</Text> : ''}</Text>}
      {!ended && pane?.tail.length ? <Text color={C.dim}>{pane.tail[pane.tail.length - 1].slice(0, width - 4)}</Text> : null}
      {failed && !done && <Text color={C.red}>run {run?.status?.toLowerCase() ?? 'ended'} before this image finished</Text>}
    </Frame>
  );
}

function App() {
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 44;
  const cols = stdout.columns ?? 180;
  const right = Math.max(50, cols - LEFT);
  const [form, setForm] = useState<Record<FieldKey, string>>({
    repo: CFG.repoUrl, ref: CFG.defaultBranch, dockerfile: CFG.dockerfile, context: CFG.context, targets: CFG.targets.join(','), args: '',
  });
  const [focus, setFocus] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState(0);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const selectedId = runs[sel]?.id;
  const abort = useRef<AbortController>();
  const onRuns = focus === FIELDS.length;

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const { rows: list } = await hatchet.runs.list({ workflowNames: ['image-pipeline'], limit: 40, since: new Date(Date.now() - 7 * 86400_000) });
        setRuns(list
          .map((r) => ({ id: r.metadata.id, status: r.status, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, duration: r.duration, input: r.input as any, output: r.output as any, meta: (r.additionalMetadata ?? {}) as Record<string, string>, displayName: r.displayName }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
          setNote('');
          setPanes((p) => reduce(p, msg, ev.createdAt?.getTime() ?? Date.now()));
        }
      } catch (e) {
        if (!ac.signal.aborted) setNote(`stream: ${detail(e)}`);
      }
    })();
    return () => ac.abort();
  }, [selectedId]);

  const trigger = () => {
    const targets = form.targets.split(',').map((s) => s.trim()).filter(Boolean);
    const args = Object.fromEntries(form.args.split(/[\s,]+/).filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2) as [string, string]));
    const input = manualInput(form.ref || CFG.defaultBranch, form.repo, { dockerfile: form.dockerfile, context: form.context, targets, args });
    setNote(`building ${input.repository.full_name} at ${input.ref}`);
    pipeline.runNoWait(input, runOpts(input.repository.full_name, input.ref)).then(() => { setNote('queued'); setSel(0); }, (e) => setNote(`trigger: ${detail(e)}`));
  };

  useInput((_, key) => {
    if (key.tab) setFocus((f) => (f + (key.shift ? FIELDS.length : 1)) % (FIELDS.length + 1));
    if (onRuns && key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (onRuns && key.downArrow) setSel((i) => Math.min(runs.length - 1, i + 1));
    if (onRuns && key.return && runs[sel]) {
      const r = runs[sel];
      setForm({
        repo: r.input?.repository?.clone_url ?? form.repo,
        ref: String(r.input?.ref ?? '').replace(/^refs\/(heads|tags)\//, '') || form.ref,
        dockerfile: r.input?.build?.dockerfile ?? form.dockerfile,
        context: r.input?.build?.context ?? form.context,
        targets: (r.input?.build?.targets ?? CFG.targets).join(','),
        args: Object.entries(r.input?.build?.args ?? {}).map(([k, v]) => `${k}=${v}`).join(' '),
      });
      setFocus(0);
    }
  });

  const selected = runs[sel];
  const names = Object.keys(panes).length ? Object.keys(panes) : ((selected?.input?.build?.targets as string[] | undefined) ?? CFG.targets).map((t) => t || 'image');
  const paneHeight = Math.max(9, Math.floor((rows - 1) / Math.max(1, names.length)));
  const formHeight = FIELDS.length + 3;

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={LEFT}>
          <Frame title="BUILD" meta="enter runs it" color={onRuns ? C.dim : C.purple} width={LEFT} height={formHeight}>
            {FIELDS.map((f, i) => (
              <Box key={f.key}>
                <Text color={focus === i ? C.cyan : C.dim}>{focus === i ? '▶ ' : '  '}{f.label.padEnd(22)}</Text>
                <TextInput value={form[f.key]} placeholder={f.placeholder} focus={focus === i} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} onSubmit={trigger} />
              </Box>
            ))}
          </Frame>
          <Frame title="RUNS" meta={`${runs.length}`} color={onRuns ? C.purple : C.dim} width={LEFT}>
            {runs.slice(0, rows - formHeight - 5).map((r, i) => {
              const [glyph, color] = STATUS[r.status === 'QUEUED' && r.startedAt && !r.finishedAt ? 'RUNNING' : r.status] ?? ['?', C.dim];
              const repo = r.meta.repo ?? r.input?.repository?.full_name;
              const ref = String(r.meta.ref ?? r.input?.ref ?? '').replace(/^refs\/(heads|tags)\//, '');
              const label = repo ? `${repoName(String(repo))}:${ref}` : r.displayName;
              const sha = String(r.output?.sha ?? r.input?.after ?? '').slice(0, 12);
              return (
                <Text key={r.id} inverse={i === sel}>
                  <Text color={color}>{glyph}</Text> {age(r.createdAt).padStart(4)} <Text color={C.lilac}>{label.padEnd(26).slice(0, 26)}</Text> <Text color={C.cyan}>{sha.padEnd(12)}</Text> <Text color={C.dim}>{(r.duration ? secs(r.duration) : '').padStart(6)}</Text>
                </Text>
              );
            })}
            {runs.length === 0 && <Text color={C.dim}>no runs yet</Text>}
          </Frame>
        </Box>
        <Box flexDirection="column" width={right}>
          {names.map((n) => <BuildPane key={n} name={n} pane={panes[n]} width={right} height={paneHeight} tick={tick} run={selected} />)}
        </Box>
      </Box>
      <Text>
        <Key k="tab" label="next field / runs" /><Key k="enter" label={onRuns ? 'load run into form' : 'build'} /><Key k="↑↓" label="select run" /><Key k="ctrl+c" label="quit" />
        <Text color={C.orange}>{note}</Text>
      </Text>
    </Box>
  );
}

render(<App />);
