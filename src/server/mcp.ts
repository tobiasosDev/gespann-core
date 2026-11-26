import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Judged } from "../verify/verdict.ts";
import type { Db, Project, Run } from "./db.ts";
import { runComment } from "./gate.ts";

/**
 * Read-only MCP server (Streamable HTTP, stateless JSON responses) for coding agents: the status of
 * a run, its issues, the review text, the screenshots and the recording. Nothing here changes state.
 */

/** Who asks: a user sees the projects of repositories they can access; the operator sees all. */
export type Viewer = { userId: number } | { operator: true };

export interface McpDeps {
  db: Db;
  dataDir: string;
  baseUrl: string;
}

const VERSION = "0.3.0";
/** From 2025-06-18 on: tool results use resource_link for the recording. */
const PROTOCOLS = ["2025-11-25", "2025-06-18"];
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };
/** Larger images come back as a link only: agents' context limits are far below this. */
const MAX_INLINE_IMAGE = 4 * 1024 * 1024;

const INSTRUCTIONS =
  "gespann tests pull requests in a production-near copy of the app and writes a verdict (PASS, FAIL, BLOCKED, SKIP) with checks, screenshots and a recording. " +
  "Start with get_run (repo + pr gives the newest run of a PR); its `issues` list what failed or blocked. get_review returns the PR comment, get_run_file a screenshot (as an image) or the recording (as a link), get_run_log the job log. Read-only: these tools never start, cancel or approve anything.";

class ToolError extends Error {}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, v: Viewer, d: McpDeps) => ToolResult;
}

interface Content {
  type: string;
  [k: string]: unknown;
}

interface ToolResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const json = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });

function visible(d: McpDeps, v: Viewer): Project[] {
  return "operator" in v ? d.db.allProjects() : d.db.projects(v.userId);
}

function projectOf(d: McpDeps, v: Viewer, ref: unknown): Project {
  const s = String(ref ?? "").trim();
  if (!s) throw new ToolError("give a project: its id or owner/repo");
  const p = visible(d, v).find((x) => String(x.id) === s || x.repo.toLowerCase() === s.toLowerCase());
  if (!p) throw new ToolError(`no project ${JSON.stringify(s)} that you can see; list_projects shows yours`);
  return p;
}

function runOf(d: McpDeps, v: Viewer, args: Record<string, unknown>): { run: Run; project: Project } {
  if (args.run_id !== undefined) {
    const run = d.db.run_(Number(args.run_id));
    const project = run ? visible(d, v).find((p) => p.id === run.project_id) : undefined;
    if (!run || !project) throw new ToolError(`run ${String(args.run_id)} not found`);
    return { run, project };
  }
  if (args.repo !== undefined && args.pr !== undefined) {
    const project = projectOf(d, v, args.repo);
    const run = d.db.runsOfPr(project.id, Number(args.pr), 1)[0];
    if (!run) throw new ToolError(`gespann has no run for ${project.repo}#${String(args.pr)}`);
    return { run, project };
  }
  throw new ToolError("give run_id, or repo and pr");
}

const runUrl = (d: McpDeps, run: Run) => `${d.baseUrl}/runs/${run.id}`;
const fileUrl = (d: McpDeps, run: Run, file: string) => `${d.baseUrl}/proof/${run.token}/${encodeURIComponent(file)}`;
const judgedOf = (run: Run): Judged | null => (run.verdict ? (JSON.parse(run.verdict) as Judged) : null);
const filesOf = (run: Run): string[] => JSON.parse(run.files) as string[];
const kindOf = (file: string) => (IMAGE_TYPES[extname(file).toLowerCase()] ? "image" : VIDEO_TYPES[extname(file).toLowerCase()] ? "video" : "data");

function runRow(d: McpDeps, run: Run) {
  return { run_id: run.id, pr: run.pr, title: run.title, head: run.head, base_ref: run.base_ref, status: run.status, outcome: run.outcome, created: run.created, finished: run.finished, error: run.error, url: runUrl(d, run) };
}

/** What a coding agent has to act on: gespann's own failure, a rejected verdict, every check that did not pass. */
function issuesOf(run: Run, judged: Judged | null) {
  const issues: { kind: string; text: string; observed?: string; fix?: string; proof?: string[] }[] = [];
  if (run.error) issues.push({ kind: judged?.verdict ? "run_note" : "run_error", text: run.error });
  for (const p of judged?.problems ?? []) issues.push({ kind: "verdict_rejected", text: p });
  for (const c of judged?.verdict?.checks ?? []) {
    if (c.result === "pass") continue;
    issues.push({ kind: c.result === "fail" ? "check_failed" : "check_blocked", text: c.expect, observed: c.observed, ...(c.fix ? { fix: c.fix } : {}), ...(c.proof?.length ? { proof: c.proof } : {}) });
  }
  for (const g of judged?.verdict?.goals ?? []) {
    if (g.result === "met") continue;
    issues.push({ kind: g.result === "missed" ? "goal_missed" : "goal_blocked", text: `${g.issue}: ${g.goal}`, observed: g.observed, ...(g.proof?.length ? { proof: g.proof } : {}) });
  }
  return issues;
}

/** The merge gate for this run's PR, from gespann's own memory (no GitHub call). */
function mergeGate(d: McpDeps, p: Project, run: Run) {
  if (!p.gate) return { on: false };
  const h = d.db.hold(p.id, run.pr);
  return { on: true, held_as_draft: h?.held === 1, approved_by: h?.approved_by ?? null, approved_head: h?.approved_head ?? null };
}

const TOOLS: Tool[] = [
  {
    name: "list_projects",
    title: "List projects",
    description: "The repositories gespann tests that you can see, with their setup state and newest run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: (_a, v, d) =>
      json({
        projects: visible(d, v).map((p) => {
          const last = d.db.runs(p.id, 1)[0];
          return { project_id: p.id, repo: p.repo, setup: p.setup, testing_prs: !!p.active, merge_gate: !!p.gate, last_run: last ? runRow(d, last) : null };
        }),
      }),
  },
  {
    name: "list_runs",
    title: "List runs",
    description: "Runs of one project, newest first; with pr only the runs of that pull request.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "project id or owner/repo" },
        pr: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "default 20" },
      },
      required: ["project"],
      additionalProperties: false,
    },
    call: (a, v, d) => {
      const p = projectOf(d, v, a.project);
      const limit = Math.min(100, Math.max(1, Number(a.limit ?? 20) || 20));
      const runs = a.pr !== undefined ? d.db.runsOfPr(p.id, Number(a.pr), limit) : d.db.runs(p.id, limit);
      return json({ repo: p.repo, runs: runs.map((r) => runRow(d, r)) });
    },
  },
  {
    name: "get_run",
    title: "Get run",
    description:
      "Status, verdict, summary, every check (expected, observed, result, proof files, suggested fix), per linked GitHub issue whether its goal was met or missed, and the issues to act on. Give run_id, or repo and pr for the newest run of that pull request.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "integer" }, repo: { type: "string", description: "owner/repo or project id" }, pr: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    call: (a, v, d) => {
      const { run, project } = runOf(d, v, a);
      const judged = judgedOf(run);
      const files = filesOf(run);
      return json({
        ...runRow(d, run),
        repo: project.repo,
        started: run.started,
        merge_gate: mergeGate(d, project, run),
        verdict_written: judged?.verdict?.verdict ?? null,
        summary: judged?.verdict?.summary ?? null,
        issues: issuesOf(run, judged),
        checks: (judged?.verdict?.checks ?? []).map((c, i) => ({ n: i + 1, ...c })),
        goals: judged?.verdict?.goals ?? [],
        proof: judged?.verdict?.proof ?? [],
        files: files.map((f) => ({ name: f, kind: kindOf(f), url: fileUrl(d, run, f) })),
      });
    },
  },
  {
    name: "get_review",
    title: "Get review",
    description: "The review of this run as gespann posts it on the pull request, in Markdown (summary, open checks, passed checks, screenshot links). The merge gate's state is in get_run.",
    inputSchema: { type: "object", properties: { run_id: { type: "integer" }, repo: { type: "string" }, pr: { type: "integer", minimum: 1 } }, additionalProperties: false },
    call: (a, v, d) => {
      const { run } = runOf(d, v, a);
      if (run.status === "queued" || run.status === "running") return { content: [{ type: "text", text: `Run ${run.id} is ${run.status}; the review is written when it ends.` }] };
      if (run.status === "cancelled") return { content: [{ type: "text", text: `Run ${run.id} was cancelled (${run.error ?? "superseded"}); it has no review.` }] };
      const review = runComment(d.baseUrl, run, judgedOf(run), filesOf(run), "");
      // gespann comments only when there is something to read (not for an ungated SKIP), and a post can fail.
      const note = run.comment_id ? "" : `Not posted on the pull request: gespann wrote no comment for run ${run.id} (outcome ${run.outcome ?? "none"}). This is the review as gespann renders it.\n\n`;
      return { content: [{ type: "text", text: note + review }] };
    },
  },
  {
    name: "get_run_file",
    title: "Get run file",
    description: "One file of a run: a screenshot comes back as an image, the recording as a link (MCP has no video content), verdict.json as text. get_run lists the files.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "integer" }, file: { type: "string", description: "a file name from get_run" } },
      required: ["run_id", "file"],
      additionalProperties: false,
    },
    call: (a, v, d) => {
      const { run } = runOf(d, v, { run_id: a.run_id });
      const file = String(a.file ?? "");
      if (!filesOf(run).includes(file)) throw new ToolError(`run ${run.id} has no file ${JSON.stringify(file)}; get_run lists its files`);
      const path = join(d.dataDir, "runs", String(run.id), file);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        throw new ToolError(`the file ${file} of run ${run.id} is no longer stored`);
      }
      const url = fileUrl(d, run, file);
      const ext = extname(file).toLowerCase();
      const image = IMAGE_TYPES[ext];
      const video = VIDEO_TYPES[ext];
      const link: Content = { type: "resource_link", uri: url, name: file, mimeType: image ?? video ?? "application/json", size };
      if (image && size <= MAX_INLINE_IMAGE) return { content: [{ type: "image", data: readFileSync(path).toString("base64"), mimeType: image }, { type: "text", text: `${file} (${size} bytes): ${url}` }] };
      if (image || video)
        return {
          content: [
            { type: "text", text: `${file} is ${video ? "the run's screen recording" : "too large to inline"} (${size} bytes, ${image ?? video}). Download: ${url}` },
            link,
          ],
        };
      return { content: [{ type: "text", text: readFileSync(path, "utf8").slice(0, 200_000) }] };
    },
  },
  {
    name: "get_run_log",
    title: "Get run log",
    description: "The end of the job log of a run: copy up, tester, verdict, copy down. Useful when a run failed without a verdict.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "integer" }, tail_lines: { type: "integer", minimum: 1, maximum: 5000, description: "default 300" } },
      required: ["run_id"],
      additionalProperties: false,
    },
    call: (a, v, d) => {
      const { run } = runOf(d, v, { run_id: a.run_id });
      const log = d.db.jobOfRun(run.id)?.log ?? "";
      const tail = Math.min(5000, Math.max(1, Number(a.tail_lines ?? 300) || 300));
      const lines = log.split("\n");
      const shown = lines.slice(-tail - 1).join("\n");
      return { content: [{ type: "text", text: shown.trim() ? shown : `Run ${run.id} has no log (status ${run.status}).` }] };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function handle(msg: RpcRequest, v: Viewer, d: McpDeps): unknown {
  if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "invalid request");
  // Notifications (no id) get no answer.
  if (msg.id === undefined) return undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gespann", title: "gespann", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `unknown tool ${JSON.stringify(msg.params?.name)}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(msg.id, tool.call(typeof args === "object" && args !== null ? args : {}, v, d));
      } catch (err) {
        if (err instanceof ToolError) return reply(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
        throw err;
      }
    }
    default:
      return fail(msg.id, -32601, `method ${msg.method} is not supported`);
  }
}

/** Answers one POSTed body: a JSON-RPC message or a batch. `null` means 202 with no body (only notifications). */
export function mcpRespond(body: unknown, v: Viewer, d: McpDeps): unknown {
  if (Array.isArray(body)) {
    const out = body.map((m) => handle(m as RpcRequest, v, d)).filter((r) => r !== undefined);
    return out.length ? out : null;
  }
  return handle(body as RpcRequest, v, d) ?? null;
}
