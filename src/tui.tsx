import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useInput, useStdout } from 'ink';
import { detail, hatchet, loadRepos, newImage, newRepo, repoName, repoSlug, saveRepos, type ImageSpec, type RepoSpec } from './client.js';
import { manualInput, paneName, pipeline, runOpts, type BuildOutput } from './workflow.js';

process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'OFF';

const C = { purple: '#7b6cff', lilac: '#b3a8ff', cyan: '#39d0ff', orange: '#ffb648', green: '#5ff59a', magenta: '#ff6ad5', red: '#ff5f6d', dim: '#5a5a7a', ink: '#e8e8ff' };
const LEFT = 62;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS: Record<string, [string, string]> = {
  QUEUED: ['○', C.dim], RUNNING: ['⟳', C.cyan], COMPLETED: ['●', C.green], FAILED: ['✗', C.red], CANCELLED: ['–', C.orange],
};
const PHASES = ['sandbox', 'checkout', 'build', 'push', 'done'];
const IMG_KEYS = ['name', 'dockerfile', 'context', 'stage', 'args'] as const;
const PLACEHOLDER: Record<string, string> = {
  url: 'https://github.com/owner/repo.git', ref: 'main', name: 'empty for a single image', dockerfile: 'Dockerfile', context: '.', stage: 'Dockerfile stage, optional', args: 'KEY=value KEY2=value',
};

type Draft = ImageSpec & { argsText?: string };
type Repo = Omit<RepoSpec, 'images'> & { images: Draft[] };
type Field = { label: string; key: string; img?: number };
type Run = { id: string; status: string; createdAt: string; startedAt?: string; finishedAt?: string; duration?: number; input: any; output: any; meta: Record<string, string>; displayName: string };
type Step = { id: number; label: string; state: 'running' | 'done' | 'cached' | 'error' | 'canceled'; dur?: string };
type Pane = Partial<BuildOutput> & { steps: Map<number, Step>; tail: string[]; phase: number; startedAt: number; endedAt?: number };
type Msg = { name?: string; phase?: string; log?: string; names?: string[]; note?: string } & Partial<BuildOutput>;

const fmtArgs = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}=${v}`).join(' ');
const parseArgs = (s: string) => Object.fromEntries(s.split(/[\s,]+/).filter((a) => a.includes('=')).map((a) => a.split(/=(.*)/s).slice(0, 2) as [string, string]));
const strip = (r: Repo): RepoSpec => ({ ...r, images: r.images.map(({ argsText: _, ...img }) => ({ ...img, ...(img.stage ? {} : { stage: undefined }) })) });
const fieldsOf = (r: Repo): Field[] => [{ label: 'url', key: 'url' }, { label: 'ref', key: 'ref' }, ...r.images.flatMap((_, i) => IMG_KEYS.map((k) => ({ label: k, key: k, img: i })))];
const getField = (r: Repo, f: Field) => (f.img === undefined ? r[f.key as 'url' | 'ref'] : f.key === 'args' ? (r.images[f.img].argsText ?? fmtArgs(r.images[f.img].args)) : (r.images[f.img][f.key as 'name' | 'dockerfile' | 'context' | 'stage'] ?? ''));
const setField = (r: Repo, f: Field, v: string): Repo => {
  if (f.img === undefined) return { ...r, [f.key]: v };
  const images = r.images.map((img, i) => (i !== f.img ? img : f.key === 'args' ? { ...img, argsText: v, args: parseArgs(v) } : { ...img, [f.key]: v }));
  return { ...r, images };
};

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

function Input({ value, onChange, onSubmit, focus, placeholder }: { value: string; onChange: (v: string) => void; onSubmit: () => void; focus: boolean; placeholder: string }) {
  const [cur, setCur] = useState(value.length);
  useEffect(() => setCur(value.length), [focus]);
  const c = Math.min(cur, value.length);
  useInput((input, key) => {
    if (key.return) return onSubmit();
    if (key.leftArrow) return setCur(Math.max(0, c - 1));
    if (key.rightArrow) return setCur(Math.min(value.length, c + 1));
    if (key.backspace || key.delete) {
      if (c > 0) {
        onChange(value.slice(0, c - 1) + value.slice(c));
        setCur(c - 1);
      }
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || !input || /[\u0000-\u001f\u007f]/.test(input)) return;
    onChange(value.slice(0, c) + input + value.slice(c));
    setCur(c + input.length);
  }, { isActive: focus });
  if (!focus) return <Text color={value ? C.ink : C.dim}>{value || placeholder}</Text>;
  return <Text>{value.slice(0, c)}<Text inverse>{value[c] ?? ' '}</Text>{value.slice(c + 1)}{!value && <Text color={C.dim}> {placeholder}</Text>}</Text>;
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
  const failed = ended && !done && run?.status !== 'COMPLETED';
  const color = failed ? C.red : done ? C.green : ended ? C.orange : pane ? C.cyan : C.dim;
  const elapsed = pane ? secs((pane.endedAt ?? runEnded ?? Date.now()) - pane.startedAt) : '';
  const steps = [...(pane?.steps.values() ?? [])].sort((a, b) => a.id - b.id).filter((s) => s.label);
  const layers = steps.filter((s) => !s.label.startsWith('[internal]') && (s.state === 'done' || s.state === 'cached'));
  const cached = layers.filter((s) => s.state === 'cached').length;
  const meta = pane
    ? [pane.skipped ? 'exists' : pane.cacheHit === undefined ? '' : pane.cacheHit ? 'warm sandbox' : 'cold sandbox', layers.length ? `${cached}/${layers.length} layers cached` : '', elapsed].filter(Boolean).join(' · ')
    : 'waiting';
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
      {pane?.skipped && <Text color={C.orange}>tag already in registry, nothing to build</Text>}
      <Box flexGrow={1} />
      {pane?.image && <Text color={C.lilac}>{pane.image}{pane.digest ? <Text color={C.dim}>@{pane.digest.slice(0, 19)}</Text> : ''}</Text>}
      {!ended && pane?.tail.length ? <Text color={C.dim}>{pane.tail[pane.tail.length - 1].slice(0, width - 4)}</Text> : null}
      {failed && <Text color={C.red}>run {run?.status?.toLowerCase() ?? 'ended'} during {PHASES[pane?.phase ?? 0] ?? 'start'}</Text>}
    </Frame>
  );
}

function App() {
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 44;
  const cols = stdout.columns ?? 180;
  const right = Math.max(50, cols - LEFT);
  const [repos, setRepos] = useState<Repo[]>(() => {
    const r = loadRepos();
    return r.length ? r : [newRepo()];
  });
  const [tab, setTab] = useState(0);
  const [focus, setFocus] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState(0);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const [selInput, setSelInput] = useState<any>();
  const abort = useRef<AbortController>();
  const repo = repos[Math.min(tab, repos.length - 1)];
  const fields = fieldsOf(repo);
  const onRuns = focus >= fields.length;
  const slugOf = repoSlug(repo.url);
  const mine = runs.filter((r) => !r.meta.repo || repoSlug(r.meta.repo) === slugOf);
  const selected = mine[sel];
  const selectedId = selected?.id;

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      saveRepos(repos.map(strip));
    } catch (e) {
      setNote(`save: ${detail(e)}`);
    }
  }, [repos]);

  useEffect(() => {
    const poll = async () => {
      try {
        const { rows: list } = await hatchet.runs.list({ workflowNames: ['image-pipeline'], limit: 100, since: new Date(Date.now() - 7 * 86400_000) });
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
    setSelInput(undefined);
    if (!selectedId) return;
    hatchet.runs.get(selectedId).then((d) => setSelInput(d.run?.input), () => undefined);
    const ac = new AbortController();
    abort.current = ac;
    void (async () => {
      try {
        for await (const ev of hatchet.streams.subscribe(`pipeline:${selectedId}`, { signal: ac.signal })) {
          const msg = JSON.parse(new TextDecoder().decode(ev.payload)) as Msg;
          setNote(msg.note ?? '');
          setPanes((p) => reduce(p, msg, ev.createdAt?.getTime() ?? Date.now()));
        }
      } catch (e) {
        if (!ac.signal.aborted) setNote(`stream: ${detail(e)}`);
      }
    })();
    return () => ac.abort();
  }, [selectedId]);

  const update = (fn: (r: Repo) => Repo) => setRepos((rs) => rs.map((r, i) => (i === tab ? fn(r) : r)));
  const switchTab = (i: number) => {
    setTab(i);
    setSel(0);
    setFocus((f) => Math.min(f, fieldsOf(repos[i] ?? newRepo()).length));
  };

  const trigger = () => {
    if (!repo.url) return setNote('repo url is empty');
    const input = manualInput(strip(repo));
    setNote(`building ${input.repository.full_name} at ${input.ref}`);
    pipeline.runNoWait(input, runOpts(input.repository.full_name, input.ref)).then(() => { setNote('queued'); setSel(0); }, (e) => setNote(`trigger: ${detail(e)}`));
  };

  useInput((input, key) => {
    const n = fields.length + 1;
    if (key.tab) setFocus((f) => (f + (key.shift ? n - 1 : 1)) % n);
    if (key.ctrl && input === 'n' && repos.length > 1) switchTab((tab + 1) % repos.length);
    if (key.ctrl && input === 't') {
      setRepos((rs) => [...rs, newRepo()]);
      switchTab(repos.length);
      setFocus(0);
    }
    if (key.ctrl && input === 'w' && repos.length > 1) {
      setRepos((rs) => rs.filter((_, i) => i !== tab));
      switchTab(Math.max(0, tab - 1));
    }
    if (key.ctrl && input === 'a') {
      const at = fields[focus]?.img ?? repo.images.length - 1;
      update((r) => ({ ...r, images: [...r.images.slice(0, at + 1), newImage(), ...r.images.slice(at + 1)] }));
      setFocus(2 + (at + 1) * IMG_KEYS.length);
    }
    if (key.ctrl && input === 'x' && fields[focus]?.img !== undefined && repo.images.length > 1) {
      const at = fields[focus].img!;
      update((r) => ({ ...r, images: r.images.filter((_, i) => i !== at) }));
      setFocus(Math.min(focus, 2 + (repo.images.length - 2) * IMG_KEYS.length));
    }
    if (!onRuns && key.upArrow) setFocus((f) => Math.max(0, f - 1));
    if (!onRuns && key.downArrow) setFocus((f) => f + 1);
    if (onRuns && key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (onRuns && key.downArrow) setSel((i) => Math.min(mine.length - 1, i + 1));
    if (onRuns && key.return && selInput?.build?.images) {
      const b = selInput.build as { images: ImageSpec[] };
      update((r) => ({ ...r, ref: String(selInput.ref ?? r.ref).replace(/^refs\/(heads|tags)\//, ''), images: b.images.map((img) => ({ ...img, args: img.args ?? {} })) }));
      setFocus(0);
    }
  });

  const names = Object.keys(panes).length ? Object.keys(panes) : ((selInput?.build?.images as ImageSpec[] | undefined) ?? repo.images).map(paneName);
  const paneHeight = Math.max(9, Math.floor((rows - 1) / Math.max(1, names.length)));
  const formRows = fields.length + repo.images.length;
  const formHeight = Math.min(formRows + 2, rows - 12);
  const focusLine = focus < fields.length ? focus + (fields[focus].img ?? -1) + 1 : 0;
  const skip = Math.max(0, focusLine - (formHeight - 3));
  let line = 0;
  const formLines: React.ReactNode[] = [];
  fields.forEach((f, i) => {
    if (f.img !== undefined && f.key === 'name') {
      const title = ` ${paneName(repo.images[f.img])} `;
      if (line++ >= skip) formLines.push(<Text key={`sep${f.img}`} color={C.dim}>{'  ── '}<Text color={C.lilac}>{title}</Text>{'─'.repeat(Math.max(1, LEFT - 10 - title.length))}</Text>);
    }
    if (line++ >= skip) formLines.push(
      <Box key={i}>
        <Text color={focus === i ? C.cyan : C.dim}>{focus === i ? '▶ ' : '  '}{f.label.padEnd(12)}</Text>
        <Input value={getField(repo, f)} placeholder={PLACEHOLDER[f.key]} focus={focus === i} onChange={(v) => update((r) => setField(r, f, v))} onSubmit={trigger} />
      </Box>
    );
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={LEFT}>
          <Text>
            {repos.map((r, i) => (
              <Text key={i} inverse={i === tab} color={i === tab ? C.purple : C.dim} bold={i === tab}>{` ${repoName(repoSlug(r.url)) || 'new repo'} `}</Text>
            ))}
            <Text color={C.dim}> ctrl+t new</Text>
          </Text>
          <Frame title="BUILD" meta={`${repo.images.length} image${repo.images.length === 1 ? '' : 's'}`} color={onRuns ? C.dim : C.purple} width={LEFT} height={formHeight}>
            {formLines}
          </Frame>
          <Frame title="RUNS" meta={`${mine.length}`} color={onRuns ? C.purple : C.dim} width={LEFT}>
            {mine.slice(0, Math.max(1, rows - formHeight - 6)).map((r, i) => {
              const [glyph, color] = STATUS[r.status === 'QUEUED' && r.startedAt && !r.finishedAt ? 'RUNNING' : r.status] ?? ['?', C.dim];
              const ref = String(r.meta.ref ?? '').replace(/^refs\/(heads|tags)\//, '');
              const who = r.meta.repo ? '' : 'webhook ';
              const sha = String(r.output?.sha ?? r.input?.after ?? '').slice(0, 12);
              const count = r.output?.images?.length;
              return (
                <Text key={r.id} inverse={i === sel}>
                  <Text color={color}>{glyph}</Text> {age(r.createdAt).padStart(4)} <Text color={C.lilac}>{(who + ref).padEnd(20).slice(0, 20)}</Text> <Text color={C.cyan}>{sha.padEnd(12)}</Text> <Text color={C.dim}>{(count ? `${count} img` : '').padStart(6)} {(r.duration ? secs(r.duration) : '').padStart(5)}</Text>
                </Text>
              );
            })}
            {mine.length === 0 && <Text color={C.dim}>no runs for this repo yet</Text>}
          </Frame>
        </Box>
        <Box flexDirection="column" width={right}>
          {names.map((n) => <BuildPane key={n} name={n} pane={panes[n]} width={right} height={paneHeight} tick={tick} run={selected} />)}
        </Box>
      </Box>
      <Text>
        <Key k="enter" label={onRuns ? 'load run' : 'build'} /><Key k="tab ↑↓" label="move" /><Key k="^n" label="next repo" /><Key k="^t ^w" label="new / close repo" /><Key k="^a ^x" label="add / remove image" /><Key k="^c" label="quit" />
        <Text color={C.orange}>{note}</Text>
      </Text>
    </Box>
  );
}

render(<App />);
