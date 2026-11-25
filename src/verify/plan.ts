import { matchesAny } from "../glob.ts";
import type { Recipe, Trigger } from "./recipe.ts";

export interface PullRequest {
  base: string;
  labels: string[];
  changed: string[];
}

/** Whether a PR runs, and why: the label forces it, otherwise one changed file that matters. */
export function triggered(t: Trigger, pr: PullRequest): { run: boolean; reason: string } {
  if (t.branches.length && !t.branches.includes(pr.base)) return { run: false, reason: `base ${pr.base} is not ${t.branches.join(" or ")}` };
  if (t.label && pr.labels.includes(t.label)) return { run: true, reason: `label ${t.label}` };
  const hit = pr.changed.find((f) => !matchesAny(f, t.ignore) && matchesAny(f, t.paths));
  return hit ? { run: true, reason: `${hit} changed` } : { run: false, reason: "no changed file matches trigger.paths" };
}

export interface Phase {
  phase: "setup" | "service" | "flags" | "up" | "alongside" | "tester" | "wait" | "verdict" | "down" | "stop" | "cleanup";
  name: string;
  run?: string;
  /** Runs even when an earlier phase failed. */
  always?: boolean;
}

/** The order a run follows. The runner executes exactly this list; `gespann recipe` prints it. */
export function plan(r: Recipe): Phase[] {
  const out: Phase[] = [];
  for (const s of r.setup) out.push({ phase: "setup", name: s.name, run: s.run });
  for (const s of r.services) out.push({ phase: "service", name: s.name, run: s.run });
  if (r.flags) out.push({ phase: "flags", name: "feature flags", run: r.flags.run });
  out.push({ phase: "up", name: "environment up", run: r.env.up });
  for (const a of r.alongside) out.push({ phase: "alongside", name: a.name, run: a.run });
  out.push({ phase: "tester", name: `tester on ${r.env.url}` });
  for (const a of r.alongside) out.push({ phase: "wait", name: a.name });
  out.push({ phase: "verdict", name: "validate verdict.json" });
  out.push({ phase: "down", name: "environment down", run: r.env.down, always: true });
  for (const s of r.services) out.push({ phase: "stop", name: s.name, always: true });
  for (const s of r.cleanup) out.push({ phase: "cleanup", name: s.name, run: s.run, always: true });
  return out;
}

export function renderPlan(r: Recipe): string {
  const lines = plan(r).map((p, i) => `${String(i + 1).padStart(2)}. ${p.phase.padEnd(9)} ${p.name}${p.always ? " (always)" : ""}`);
  const t = r.trigger;
  return [
    `mode ${r.mode}, timeout ${r.timeout} min`,
    `trigger: ${t.branches.length ? `PRs into ${t.branches.join(", ")}` : "any PR"}, ${t.paths.length} path pattern(s), ${t.ignore.length} ignored${t.label ? `, label ${t.label}` : ""}`,
    ...lines,
  ].join("\n");
}
