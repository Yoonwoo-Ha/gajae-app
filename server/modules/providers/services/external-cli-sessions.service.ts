import { spawn } from 'node:child_process';
import { readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import Database from 'better-sqlite3';

/**
 * External CLI (claude / codex) tmux-session detection — the Termius-style lane.
 *
 * The gjc fleet has its own richer pipeline (live-sessions.service.ts: lsof +
 * transcript files). External CLIs get a deliberately simpler, screen-level view:
 * we only need "which tmux SESSION runs claude or codex" so the UI can offer a
 * terminal attach. Detection is by PROCESS SUBTREE per pane:
 *   - tmux list-panes -a → {session_name, pane_pid, pane_current_command}
 *   - ps -eo pid,ppid,comm → children map → BFS from pane_pid → descendant comms
 *   - any 'gjc' in the subtree → the session belongs to the gjc live lane → SKIP
 *   - else 'claude' (pane cmd or descendant comm) → kind 'claude'
 *   - else 'codex' descendant comm → kind 'codex' (codex panes surface as 'node')
 *
 * Grouped per tmux session name (a session with several panes is one row).
 * tmux/ps access is ISOLATED here and fails closed to [].
 */

const TMUX_FIELD_SEP = '\t';
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_RESUME_THREAD_RE = /(?:^|\s)resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;

export type ExternalCliKind = 'claude' | 'codex' | 'ssh';
export type ExternalCliSession = {
  tmuxName: string;
  kind: ExternalCliKind;
  codexThreadId?: string;
};

export type ExternalCodexApprovalPrompt = {
  title: string;
  text: string;
  canRemember: boolean;
};

export type ExternalCodexApprovalDecision = 'approve-once' | 'approve-remember' | 'reject';

type FreshCodexProcess = { tmuxName: string; cwd: string; startedAtMs: number };
type FreshCodexThread = { id: string; cwd: string; createdAtMs: number };

/** Matches the tower/live-send tmux-name discipline; also safe to embed in a shell command. */
export const EXTERNAL_TMUX_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const CODEX_APPROVAL_HEADER_RE = /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Enable full access)/i;
const CODEX_APPROVAL_OPTION_RE = /^\s*[›>❯]?\s*\d+\.\s/;
const CODEX_APPROVAL_YES_RE = /^\s*[›>❯]?\s*1\.\s*(?:Yes|Run|Apply|Allow|Proceed|Continue)\b/i;
const CODEX_APPROVAL_NO_RE = /^\s*[›>❯]?\s*\d+\.\s*(?:No|Reject|Cancel|Deny)\b/i;

/**
 * Extracts a currently visible Codex approval modal from `tmux capture-pane`.
 *
 * Completed approvals remain in scrollback as "You approved …", so detection
 * deliberately examines only the active pane screen and requires the modal
 * header plus both affirmative and negative numbered options. This keeps the
 * web buttons fail-closed when ordinary transcript text merely mentions an
 * approval.
 */
export function parseExternalCodexApprovalScreen(screen: string): ExternalCodexApprovalPrompt | null {
  const lines = screen
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (
      CODEX_APPROVAL_HEADER_RE.test(lines[index])
      && !CODEX_APPROVAL_OPTION_RE.test(lines[index])
    ) {
      headerIndex = index;
    }
  }
  if (headerIndex < 0) return null;

  const visibleTail = lines.slice(headerIndex);
  while (visibleTail.length > 0 && !visibleTail.at(-1)?.trim()) {
    visibleTail.pop();
  }
  if (
    visibleTail.length === 0
    || visibleTail.length > 40
    || !visibleTail.some((line) => CODEX_APPROVAL_YES_RE.test(line))
    || !visibleTail.some((line) => CODEX_APPROVAL_NO_RE.test(line))
  ) {
    return null;
  }

  const title = visibleTail[0].trim();
  const text = visibleTail.join('\n').trim().slice(0, 12_000);
  return {
    title,
    text,
    canRemember: /don't ask again|always allow|this session|remember|commands that start with/i.test(text),
  };
}

/** Extracts the native Codex thread id from `codex resume <uuid>` argv. */
export function extractCodexResumeThreadId(processArgs: string | undefined): string | null {
  return processArgs?.match(CODEX_RESUME_THREAD_RE)?.[1] ?? null;
}

/**
 * Reads a Codex thread id from an open rollout path, while rejecting files
 * outside ~/.codex/sessions. This also handles `/resume` selected inside the
 * TUI: the selected id is absent from argv, but Codex keeps its JSONL open.
 */
export function extractCodexThreadIdFromRolloutPath(
  filePath: string,
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
): string | null {
  const normalizedPath = filePath.endsWith(' (deleted)')
    ? filePath.slice(0, -' (deleted)'.length)
    : filePath;
  const rel = relative(sessionsRoot, normalizedPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const match = basename(normalizedPath).match(
    /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

/** Assigns each newly-created native thread to the closest preceding tmux Codex process. */
export function assignFreshCodexThreadIds(
  processes: FreshCodexProcess[],
  threads: FreshCodexThread[],
  windowMs = 10 * 60 * 1000,
): Map<string, string> {
  const assigned = new Map<string, string>();
  for (const thread of [...threads].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
    const eligible = processes.filter((process) => (
      !assigned.has(process.tmuxName)
      && process.cwd === thread.cwd
      && thread.createdAtMs >= process.startedAtMs - 5_000
      && thread.createdAtMs <= process.startedAtMs + windowMs
    ));
    const preceding = eligible
      .filter((process) => process.startedAtMs <= thread.createdAtMs)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    const owner = preceding[0]
      ?? eligible.sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    if (owner) {
      assigned.set(owner.tmuxName, thread.id);
    }
  }
  return assigned;
}

/** Parses pane identity plus the optional Gajae Codex transcript user-option. */
export function parseExternalPanes(output: string): Array<{
  name: string;
  pid: number;
  command: string;
  codexThreadId?: string;
  cwd?: string;
}> {
  const panes: Array<{ name: string; pid: number; command: string; codexThreadId?: string; cwd?: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) {
      continue;
    }
    const first = raw.indexOf(TMUX_FIELD_SEP);
    const second = raw.indexOf(TMUX_FIELD_SEP, first + 1);
    if (first < 0 || second < 0) {
      continue;
    }
    const name = raw.slice(0, first).trim();
    const pid = Number.parseInt(raw.slice(first + 1, second).trim(), 10);
    const third = raw.indexOf(TMUX_FIELD_SEP, second + 1);
    const command = (third < 0
      ? raw.slice(second + 1)
      : raw.slice(second + 1, third)).trim();
    const fourth = third < 0 ? -1 : raw.indexOf(TMUX_FIELD_SEP, third + 1);
    const codexThreadId = third < 0
      ? ''
      : (fourth < 0 ? raw.slice(third + 1) : raw.slice(third + 1, fourth)).trim();
    const cwd = fourth < 0 ? '' : raw.slice(fourth + 1).trim();
    if (name && Number.isFinite(pid)) {
      panes.push({
        name,
        pid,
        command,
        ...(codexThreadId ? { codexThreadId } : {}),
        ...(cwd ? { cwd } : {}),
      });
    }
  }
  return panes;
}

/** Parses `ps -eo pid,ppid,comm[,args]` output (header tolerated). */
export function parsePsTree(output: string): Array<{ pid: number; ppid: number; comm: string; args?: string }> {
  const rows: Array<{ pid: number; ppid: number; comm: string; args?: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) {
      continue; // header or malformed line
    }
    const processArgs = match[4]?.trim();
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      comm: match[3],
      ...(processArgs ? { args: processArgs } : {}),
    });
  }
  return rows;
}

/**
 * Pure classification: tmux panes + a ps snapshot → external CLI sessions.
 *
 * Per pane, the comm set is {pane_current_command} ∪ {comm of every /proc
 * descendant of pane_pid} (depth/cycle guarded). Per tmux session (union of its
 * panes): 'gjc' anywhere → excluded (that session is the gjc live lane's —
 * never touched here); else the kind is the first match of claude → codex →
 * ssh ('ssh' = a remote tunnel whose far-side CLI is locally unprovable —
 * attach-only). Sessions with none of the three are dropped (plain shells).
 * Names failing EXTERNAL_TMUX_NAME_RE are dropped (they could not be attached
 * safely). Output is sorted by name for stability.
 */
export function classifyExternalSessions(args: {
  panes: Array<{ name: string; pid: number; command: string; codexThreadId?: string; cwd?: string }>;
  procs: Array<{ pid: number; ppid: number; comm: string; args?: string }>;
}): ExternalCliSession[] {
  const children = new Map<number, number[]>();
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid);
    if (siblings) {
      siblings.push(proc.pid);
    } else {
      children.set(proc.ppid, [proc.pid]);
    }
  }
  const commByPid = new Map<number, string>();
  const argsByPid = new Map<number, string>();
  for (const proc of args.procs) {
    commByPid.set(proc.pid, proc.comm);
    if (proc.args) {
      argsByPid.set(proc.pid, proc.args);
    }
  }

  const subtreePids = (rootPid: number): number[] => {
    const pids: number[] = [];
    const seen = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0 && seen.size < 4096) {
      const pid = queue.shift()!;
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      pids.push(pid);
      for (const child of children.get(pid) ?? []) {
        queue.push(child);
      }
    }
    return pids;
  };

  // Union comm sets per tmux session name.
  const commsBySession = new Map<string, Set<string>>();
  const codexThreadIdsBySession = new Map<string, Set<string>>();
  for (const pane of args.panes) {
    let comms = commsBySession.get(pane.name);
    if (!comms) {
      comms = new Set<string>();
      commsBySession.set(pane.name, comms);
    }
    if (pane.command) {
      comms.add(pane.command);
    }
    for (const pid of subtreePids(pane.pid)) {
      const comm = commByPid.get(pid);
      if (comm) {
        comms.add(comm);
      }
      const resumedThreadId = extractCodexResumeThreadId(argsByPid.get(pid));
      if (resumedThreadId) {
        let threadIds = codexThreadIdsBySession.get(pane.name);
        if (!threadIds) {
          threadIds = new Set<string>();
          codexThreadIdsBySession.set(pane.name, threadIds);
        }
        threadIds.add(resumedThreadId);
      }
    }
    if (pane.codexThreadId && CODEX_THREAD_ID_RE.test(pane.codexThreadId)) {
      let threadIds = codexThreadIdsBySession.get(pane.name);
      if (!threadIds) {
        threadIds = new Set<string>();
        codexThreadIdsBySession.set(pane.name, threadIds);
      }
      threadIds.add(pane.codexThreadId);
    }
  }

  const result: ExternalCliSession[] = [];
  for (const [name, comms] of commsBySession) {
    if (!EXTERNAL_TMUX_NAME_RE.test(name)) {
      continue;
    }
    if (comms.has('gjc')) {
      continue; // gjc live lane — out of scope by contract
    }
    if (comms.has('claude')) {
      result.push({ tmuxName: name, kind: 'claude' });
    } else if (comms.has('codex')) {
      const threadIds = [...(codexThreadIdsBySession.get(name) ?? [])];
      result.push({
        tmuxName: name,
        kind: 'codex',
        ...(threadIds.length === 1 ? { codexThreadId: threadIds[0] } : {}),
      });
    } else if (comms.has('ssh')) {
      // Remote lane: the pane tunnels into another machine, so the CLI running
      // there is invisible to local ps by definition (실측: company → ssh →
      // 원격 claude). Attach-only is still safe and useful — surface it as
      // 'ssh' instead of silently hiding the session (하코 요청).
      result.push({ tmuxName: name, kind: 'ssh' });
    }
  }
  return result.sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
}

function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
        }
      }
    });
  });
}

async function processStartMs(pid: number): Promise<number | null> {
  try {
    return (await stat(`/proc/${pid}`)).mtimeMs;
  } catch {
    return null;
  }
}

function descendants(rootPid: number, children: ReadonlyMap<number, number[]>): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0 && seen.size < 4096) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

async function readOpenCodexThreadIds(pid: number): Promise<Set<string>> {
  const ids = new Set<string>();
  const fdRoot = `/proc/${pid}/fd`;
  const entries = await readdir(fdRoot).catch(() => []);
  const targets = await Promise.all(entries.map(
    (entry) => readlink(join(fdRoot, entry)).catch(() => null),
  ));
  for (const target of targets) {
    if (!target) continue;
    const threadId = extractCodexThreadIdFromRolloutPath(target);
    if (threadId) ids.add(threadId);
  }
  return ids;
}

/**
 * Resolves the active thread from the rollout JSONL held open by Codex.
 * Unlike argv parsing, this continues to work after an in-TUI `/resume`.
 */
async function inferOpenCodexThreadIds(args: {
  sessions: ExternalCliSession[];
  panes: ReturnType<typeof parseExternalPanes>;
  procs: ReturnType<typeof parsePsTree>;
}): Promise<Map<string, string>> {
  const codexSessionNames = new Set(
    args.sessions
      .filter((session) => session.kind === 'codex')
      .map((session) => session.tmuxName),
  );
  if (codexSessionNames.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const idsBySession = new Map<string, Set<string>>();
  for (const pane of args.panes) {
    if (!codexSessionNames.has(pane.name)) continue;
    const codexPids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc?.comm === 'codex'
        && !proc.args?.includes(' app-server')
        && !proc.args?.includes('code-mode');
    });
    for (const pid of codexPids) {
      const openIds = await readOpenCodexThreadIds(pid);
      if (openIds.size === 0) continue;
      const sessionIds = idsBySession.get(pane.name) ?? new Set<string>();
      for (const id of openIds) sessionIds.add(id);
      idsBySession.set(pane.name, sessionIds);
    }
  }

  const resolved = new Map<string, string>();
  for (const [tmuxName, ids] of idsBySession) {
    if (ids.size === 1) resolved.set(tmuxName, [...ids][0]);
  }
  return resolved;
}

function readFreshCodexThreads(minCreatedAtMs: number): FreshCodexThread[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(join(homedir(), '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    return db.prepare(`
      SELECT id, cwd, COALESCE(created_at_ms, created_at * 1000) AS createdAtMs
      FROM threads
      WHERE source = 'cli'
        AND thread_source = 'user'
        AND COALESCE(created_at_ms, created_at * 1000) >= ?
      ORDER BY COALESCE(created_at_ms, created_at * 1000) ASC
    `).all(minCreatedAtMs - 5_000) as FreshCodexThread[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function inferFreshCodexThreadIds(args: {
  sessions: ExternalCliSession[];
  panes: ReturnType<typeof parseExternalPanes>;
  procs: ReturnType<typeof parsePsTree>;
}): Promise<Map<string, string>> {
  const unresolvedNames = new Set(
    args.sessions
      .filter((session) => session.kind === 'codex' && !session.codexThreadId)
      .map((session) => session.tmuxName),
  );
  if (unresolvedNames.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const processes: FreshCodexProcess[] = [];
  for (const pane of args.panes) {
    if (!unresolvedNames.has(pane.name) || !pane.cwd) continue;
    const codexPids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc?.comm === 'codex'
        && !proc.args?.includes(' app-server')
        && !proc.args?.includes('code-mode');
    });
    if (codexPids.length !== 1) continue;
    const startedAtMs = await processStartMs(codexPids[0]);
    if (startedAtMs !== null) {
      processes.push({ tmuxName: pane.name, cwd: pane.cwd, startedAtMs });
    }
  }
  if (processes.length === 0) return new Map();

  const threads = readFreshCodexThreads(Math.min(...processes.map((process) => process.startedAtMs)));
  return assignFreshCodexThreadIds(processes, threads);
}

/** Relays one literal prompt/selection into a verified native Codex tmux TUI. */
export async function sendToExternalCodexSession(tmuxName: string, message: string): Promise<void> {
  const target = `${tmuxName}:`;
  await runCommand('tmux', ['send-keys', '-t', target, '-l', '--', message]);
  // Codex coalesces a rapid key burst as paste input. Sending Enter in the
  // immediately following tmux command can land inside that paste window and
  // leave the text sitting in the composer instead of submitting it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await runCommand('tmux', ['send-keys', '-t', target, 'Enter']);
}

/** Reads only the active screen; approval history in scrollback must not re-arm buttons. */
export async function getExternalCodexApprovalPrompt(
  tmuxName: string,
): Promise<ExternalCodexApprovalPrompt | null> {
  const screen = await runCommand('tmux', ['capture-pane', '-p', '-t', `${tmuxName}:`]);
  return parseExternalCodexApprovalScreen(screen);
}

/**
 * Answers the currently visible Codex approval modal through its native
 * keyboard shortcuts. Re-capturing immediately before injection closes the
 * stale-web-snapshot race: if the prompt has already gone away, no key is sent
 * into the ordinary Codex composer.
 */
export async function answerExternalCodexApproval(
  tmuxName: string,
  decision: ExternalCodexApprovalDecision,
): Promise<void> {
  const prompt = await getExternalCodexApprovalPrompt(tmuxName);
  if (!prompt) {
    throw new Error('Codex approval prompt is no longer visible.');
  }
  if (decision === 'approve-remember' && !prompt.canRemember) {
    throw new Error('This approval prompt has no remember option.');
  }
  const key = decision === 'approve-once'
    ? 'y'
    : decision === 'approve-remember'
      ? 'p'
      : 'Escape';
  await runCommand('tmux', ['send-keys', '-t', `${tmuxName}:`, key]);
}

/** Resolves a web spawn cwd and rejects traversal/symlink escape outside HOME. */
export async function resolveExternalCodexCwd(input: string): Promise<string | null> {
  const home = await realpath(homedir()).catch(() => null);
  if (!home || input.includes('\0')) return null;
  const trimmed = input.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : isAbsolute(trimmed)
        ? trimmed
        : join(homedir(), trimmed);
  try {
    const resolved = await realpath(expanded);
    const rel = relative(home, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export async function spawnExternalCodexSession(tmuxName: string, cwd: string): Promise<void> {
  await runCommand('tmux', ['new-session', '-d', '-s', tmuxName, '-c', cwd, 'codex']);
}

export async function killExternalCodexSession(tmuxName: string): Promise<void> {
  await runCommand('tmux', ['kill-session', '-t', `=${tmuxName}`]);
}

/** Returns the tmux session hosting this server, so its own session cannot be killed. */
export async function getCurrentTmuxSessionName(): Promise<string | null> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId || !/^%\d+$/.test(paneId)) return null;
  try {
    return (await runCommand('tmux', [
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{session_name}',
    ])).trim() || null;
  } catch {
    return null;
  }
}

/** Finds and validates Codex's JSONL rollout path for immediate transcript indexing. */
export async function resolveCodexRolloutPath(threadId: string): Promise<string | null> {
  if (!CODEX_THREAD_ID_RE.test(threadId)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(join(homedir(), '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')
      .get(threadId) as { rollout_path?: unknown } | undefined;
    if (typeof row?.rollout_path !== 'string' || !row.rollout_path.endsWith('.jsonl')) {
      return null;
    }

    const [sessionsRoot, rolloutPath] = await Promise.all([
      realpath(join(homedir(), '.codex', 'sessions')),
      realpath(row.rollout_path),
    ]);
    const rel = relative(sessionsRoot, rolloutPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return rolloutPath;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Returns external CLI (claude/codex) tmux sessions. Empty on any failure
 * (no tmux, ps error) — tmux/ps dependence is confined here.
 */
export async function getExternalCliSessions(): Promise<ExternalCliSession[]> {
  let tmuxOutput: string;
  let psOutput: string;
  try {
    tmuxOutput = await runCommand('tmux', ['list-panes', '-a', '-F', `#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{@gajae_codex_thread_id}${TMUX_FIELD_SEP}#{pane_current_path}`]);
    psOutput = await runCommand('ps', ['-eo', 'pid,ppid,comm,args']);
  } catch {
    return [];
  }
  const panes = parseExternalPanes(tmuxOutput);
  const procs = parsePsTree(psOutput);
  const sessions = classifyExternalSessions({ panes, procs });
  const openIds = await inferOpenCodexThreadIds({ sessions, panes, procs });
  const sessionsWithOpenIds = sessions.map((session) => ({
    ...session,
    ...(openIds.has(session.tmuxName)
      ? { codexThreadId: openIds.get(session.tmuxName)! }
      : {}),
  }));
  const freshIds = await inferFreshCodexThreadIds({ sessions: sessionsWithOpenIds, panes, procs });
  return sessionsWithOpenIds.map((session) => ({
    ...session,
    ...(!session.codexThreadId && freshIds.has(session.tmuxName)
      ? { codexThreadId: freshIds.get(session.tmuxName)! }
      : {}),
  }));
}
