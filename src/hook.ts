import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "./adapters/index.ts";
import type { HookInput } from "./adapters/types.ts";
import { changedSinceStart, fingerprint, startSnapshot } from "./changes.ts";
import { gate } from "./gate.ts";
import { append, type CheckEvent, readEvents, sessionFile, startOf, type StopResult } from "./journal.ts";
import { activeRules, invocation, statePath } from "./rules.ts";
import { sync } from "./sync.ts";
import { dataDir, gitOk, now } from "./util.ts";

export interface HookReply {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

function rootOf(cwd: string): string | undefined {
  const r = gitOk(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  return r && existsSync(statePath(r)) ? r : undefined;
}

export function handle(input: HookInput): HookReply {
  const root = rootOf(input.cwd);
  if (!root) return {};
  const adapter = adapterFor(input.agent);
  const file = sessionFile(root, input.agent, input.session);
  const rules = activeRules(root);

  if (input.event === "start") {
    const s = sync(root);
    const snap = startSnapshot(root, rules.flatMap((r) => r.paths));
    append(root, input.agent, input.session, {
      type: "start",
      t: now(),
      agent: input.agent,
      session: input.session,
      cwd: input.cwd,
      head: snap.head,
      dirty: snap.dirty,
      rules: Object.fromEntries(rules.map((r) => [r.id, r.version])),
      ...(input.source ? { source: input.source } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    if (s.conflicts.length === 0) return {};
    return {
      systemMessage: `gespann: kept local edits in ${s.conflicts.map((c) => c.path).join(", ")} instead of approved ${s.conflicts
        .map((c) => `${c.rule} v${c.version}`)
        .join(", ")}. Run \`gespann status\` to resolve.`,
    };
  }

  if (input.event === "tool" && input.tool) {
    const t = input.tool;
    append(root, input.agent, input.session, {
      type: "tool",
      t: now(),
      kind: t.kind,
      tool: t.name,
      exit: t.exit,
      ...(t.id ? { id: t.id } : {}),
      ...(t.files ? { files: t.files } : {}),
      ...(t.command ? { command: t.command.slice(0, 2000) } : {}),
    });
    if (t.kind !== "shell" || !t.command) return {};
    const start = startOf({ agent: input.agent, session: input.session, file, events: readEvents(file) });
    for (const rule of rules) {
      const inv = invocation(t.command, rule, root, input.cwd);
      if (!inv.ran) continue;
      const files = start ? changedSinceStart(root, start, rule.paths) : [];
      // A piped or chained check reports someone else's exit code: record it as unknown.
      const own = inv.ownExit;
      const check: CheckEvent = {
        type: "check",
        t: now(),
        rule: rule.id,
        version: rule.version,
        by: "agent",
        exit: own ? t.exit : null,
        fp: fingerprint(root, files),
        files,
        ...(t.id && own ? { id: t.id } : {}),
      };
      append(root, input.agent, input.session, check);
    }
    return {};
  }

  if (input.event === "stop") {
    let events = readEvents(file);
    if (adapter.exitFromTranscript && input.transcript) {
      const open = events.filter((e): e is CheckEvent => e.type === "check" && e.exit === null && !!e.id).map((e) => e.id as string);
      for (const [id, exit] of adapter.exitFromTranscript(input.transcript, open)) {
        append(root, input.agent, input.session, { type: "exit", t: now(), id, exit });
      }
      events = readEvents(file);
    }
    const start = startOf({ agent: input.agent, session: input.session, file, events });
    const results: Record<string, StopResult> = {};
    const reasons: string[] = [];
    for (const rule of rules) {
      const outcome = gate(root, start, events, rule);
      if (outcome.check) append(root, input.agent, input.session, outcome.check);
      results[rule.id] = outcome.result;
      if (outcome.reason) reasons.push(outcome.reason);
    }
    append(root, input.agent, input.session, { type: "stop", t: now(), results });
    return reasons.length ? { decision: "block", reason: reasons.join("\n\n") } : {};
  }

  if (input.event === "end") append(root, input.agent, input.session, { type: "end", t: now() });
  return {};
}

/** Entry for `gespann hook <agent> <event>`. Never breaks the agent: errors go to a log. */
export function runHook(agentName: string, eventArg: string): void {
  let reply: HookReply = {};
  let cwd = process.cwd();
  try {
    const rawText = readFileSync(0, "utf8");
    const raw = (rawText.trim() ? JSON.parse(rawText) : {}) as Record<string, unknown>;
    const input = adapterFor(agentName).parse(raw, eventArg);
    cwd = input.cwd;
    reply = handle(input);
  } catch (err) {
    try {
      const root = gitOk(cwd, ["rev-parse", "--show-toplevel"])?.trim();
      if (root) {
        const dir = dataDir(root);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "errors.log"), `${now()} ${agentName} ${eventArg}: ${(err as Error).stack ?? err}\n`);
      }
    } catch {
      // nothing left to report to
    }
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
