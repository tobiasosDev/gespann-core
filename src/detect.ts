import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleVersion } from "./rules.ts";
import { readJson } from "./util.ts";

const JS_EXT = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const SCRIPT_KINDS: { script: RegExp; id: string; title: string; why: string; tool?: string; ext?: string }[] = [
  { script: /^lint$/, id: "lint", title: "Lint passes before a change is reported as done", why: "Lint errors found in review cost a round trip.", tool: "eslint|biome|oxlint" },
  { script: /^typecheck$|^type-check$|^tsc$/, id: "typecheck", title: "Types check before a change is reported as done", why: "Type errors found in CI cost a round trip.", tool: "tsc" },
  { script: /^test$/, id: "test", title: "Tests pass before a change is reported as done", why: "Failing tests found in CI cost a round trip." },
];

function packageManager(root: string): string {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun run";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm run";
}

function packageDirs(root: string): string[] {
  const dirs = ["."];
  for (const group of ["apps", "packages", "services"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(base, d.name, "package.json"))) dirs.push(`${group}/${d.name}`);
    }
  }
  return dirs;
}

function scriptMatch(name: string, tool?: string): string {
  const runner = `\\b(?:bun|npm|pnpm|yarn|npx|bunx)\\b[^\\n;&|]*\\b${name.replace(/[-]/g, "\\-")}\\b(?![-:])`;
  return tool ? `${runner}|\\b(?:${tool})\\b(?![-])` : runner;
}

function rule(id: string, title: string, why: string, paths: string[], command: string, cwd: string | undefined, match: string): RuleVersion {
  return {
    id,
    version: 1,
    title,
    why,
    paths,
    check: { command, ...(cwd ? { cwd } : {}), match },
    level: "observe",
    ci: "report",
  };
}

/** Find the checks a repo already has. Every rule starts in observe mode: it only measures. */
export function detect(root: string): RuleVersion[] {
  const out: RuleVersion[] = [];
  const pm = packageManager(root);
  const dirs = packageDirs(root);
  for (const kind of SCRIPT_KINDS) {
    const owners = dirs.filter((d) => {
      const scripts = readJson<{ scripts?: Record<string, string> }>(join(root, d, "package.json"))?.scripts ?? {};
      return Object.keys(scripts).some((s) => kind.script.test(s));
    });
    // Prefer the packages that own the script: their paths are precise. A root script usually just fans out to them.
    const subOwners = owners.filter((d) => d !== ".");
    const useDirs = subOwners.length > 0 ? subOwners : owners;
    for (const d of useDirs) {
      const scripts = readJson<{ scripts?: Record<string, string> }>(join(root, d, "package.json"))?.scripts ?? {};
      const name = Object.keys(scripts).find((s) => kind.script.test(s)) as string;
      const suffix = useDirs.length > 1 ? `-${d.split("/").pop()}` : "";
      const paths = d === "." ? [`**/*.${JS_EXT}`] : [`${d}/**/*.${JS_EXT}`];
      out.push(rule(`${kind.id}${suffix}`, kind.title, kind.why, paths, `${pm} ${name}`, d === "." ? undefined : d, scriptMatch(name, kind.tool)));
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    out.push(rule("clippy", "Clippy passes before a change is reported as done", "Lint errors found in review cost a round trip.", ["**/*.rs"], "cargo clippy --all-targets -- -D warnings", undefined, "\\bcargo\\s+clippy\\b"));
    out.push(rule("cargo-test", "Rust tests pass before a change is reported as done", "Failing tests found in CI cost a round trip.", ["**/*.rs"], "cargo test", undefined, "\\bcargo\\s+(?:test|nextest)\\b"));
  }
  const pyproject = existsSync(join(root, "pyproject.toml")) ? readFileSync(join(root, "pyproject.toml"), "utf8") : "";
  if (/\[tool\.ruff/.test(pyproject)) out.push(rule("ruff", "Ruff passes before a change is reported as done", "Lint errors found in review cost a round trip.", ["**/*.py"], "ruff check .", undefined, "\\bruff\\s+check\\b"));
  if (/pytest/.test(pyproject)) out.push(rule("pytest", "Tests pass before a change is reported as done", "Failing tests found in CI cost a round trip.", ["**/*.py"], "pytest -q", undefined, "\\bpytest\\b"));
  if (existsSync(join(root, "go.mod"))) out.push(rule("go-vet", "go vet passes before a change is reported as done", "Problems found in review cost a round trip.", ["**/*.go"], "go vet ./...", undefined, "\\bgo\\s+vet\\b"));
  const makefile = existsSync(join(root, "Makefile")) ? readFileSync(join(root, "Makefile"), "utf8") : "";
  if (/^lint:/m.test(makefile) && !out.some((r) => r.id.startsWith("lint"))) {
    out.push(rule("lint", "Lint passes before a change is reported as done", "Lint errors found in review cost a round trip.", ["**/*"], "make lint", undefined, "\\bmake\\s+lint\\b"));
  }
  return out;
}
