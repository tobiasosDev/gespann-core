import { spawnSync } from "node:child_process";

/**
 * Feature flags a PR touches, read from its diff before the tester starts. Only candidates: the
 * tester confirms each one from the code and tests a confirmed flag off, then on (see prompt.ts).
 */
export interface FlagChange {
  key: string;
  /** The same flag under other names, e.g. its environment variable `NEW_CHECKOUT_ENABLED` for `new-checkout`. */
  aliases?: string[];
  /** added: only on new lines; removed: only on deleted lines; changed: on both. */
  kind: "added" | "changed" | "removed";
  files: string[];
}

/** The candidates of a run, in its work dir: the tester's prompt lists them, the verdict must judge each. */
export const FLAG_CHANGES = "flag-changes.json";

/** Flag SDK and helper calls whose first argument is the flag's key: PostHog, LaunchDarkly, Unleash, GrowthBook, Statsig, OpenFeature, Flipper, waffle and the usual home-made names. */
const CALL =
  /\b(?:isFeatureEnabled|featureEnabled|isFeatureOn|isFlagEnabled|flagEnabled|isFlagOn|hasFeature|getFeatureFlag|getFeatureFlagPayload|getFeatureFlagResult|useFeatureFlag\w*|useFlag|useFeatureIsOn|useFeatureValue|useGate|useFeatureGate|checkGate|getFeatureGate|isOn|isEnabled|variation|boolVariation|stringVariation|variationDetail|getBooleanValue|getBooleanDetails|feature_enabled|is_feature_enabled|flag_is_active|switch_is_active|feature_enabled\?|enabled\?)\s*\(\s*(?:[A-Za-z_][\w.]*\s*,\s*)?["'`:]([A-Za-z][\w.:/-]*)["'`]?/g;
/** Ruby's `Flipper[:new_checkout]` / `Feature[:x]`. */
const INDEX = /\b(?:Flipper|Feature|Features|Flags)\s*\[\s*[:"']([A-Za-z][\w.-]*)["']?\s*\]/g;
/** Environment flags: FEATURE_X, FF_X, ENABLE_X (with a framework's public prefix), X_ENABLED. */
const ENV = /\b((?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)?(?:FEATURE|FF|FLAG|ENABLE)_[A-Z0-9_]*[A-Z0-9]|[A-Z][A-Z0-9_]*_(?:ENABLED|FLAG))\b/g;
/** In a flag registry file: a quoted key with a separator (`"new-checkout": {`, `key: "new_checkout"`). */
const REGISTRY = [/["'`]([a-z0-9]+(?:[-_.][a-z0-9]+)+)["'`]\s*:/g, /\b(?:key|flag|id)\s*[:=]\s*["'`]([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+)["'`]/g];
/** In a registry, `name: "X"` is a key, unless it is upper case: then it names the flag's variable (`env: { name: "NEW_CART_ENABLED" }`). */
const REGISTRY_NAME = /\bname\s*[:=]\s*["'`]([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+)["'`]/g;
/** A flag registry: a file named for flags (`flags.ts`, `features.yml`) or a file in a flag folder (`lib/feature-flags/registry.ts`). */
const REGISTRY_FILE = /(?:^|\/)[^/]*(?:flag|feature|toggle)[^/]*$|(?:^|\/)[^/]*(?:flag|toggle)[^/]*\/[^/]+$/i;
/** Tests flip flags all the time; docs and lockfiles only mention them. */
const IGNORED = /(?:^|\/)(?:tests?|__tests__|e2e|spec|fixtures|docs?)\/|\.(?:test|spec)\.\w+$|_test\.\w+$|\.(?:md|mdx|lock|snap)$|(?:^|\/)(?:package-lock\.json|CHANGELOG[^/]*)$/i;
/** Settings of the flag system itself (`FEATURE_FLAGS`, `FEATURE_FLAG_REFRESH_MS`) and values that only look like flags. */
const NOT_A_FLAG = /FLAGS|_FLAG_|_(?:MS|URL|KEY|TOKEN|SECRET|PATH|TIMEOUT|INTERVAL|TTL|SECONDS|DAYS)$/;

/** The keys on one line; `env` marks a name found only as an environment variable, not as a key the code asks for. */
function keysOf(line: string, file: string): { key: string; env: boolean }[] {
  const keys: { key: string; env: boolean }[] = [];
  for (const re of [CALL, INDEX]) for (const m of line.matchAll(re)) if (m[1]) keys.push({ key: m[1], env: false });
  if (REGISTRY_FILE.test(file)) {
    for (const re of REGISTRY) for (const m of line.matchAll(re)) if (m[1]) keys.push({ key: m[1], env: false });
    for (const m of line.matchAll(REGISTRY_NAME)) if (m[1]) keys.push({ key: m[1], env: /^[A-Z0-9_]+$/.test(m[1]) });
  }
  for (const m of line.matchAll(ENV)) if (m[1] && !NOT_A_FLAG.test(m[1]) && !keys.some((k) => k.key === m[1])) keys.push({ key: m[1], env: true });
  return keys;
}

/** One name for a flag's key and its environment variable: `new-checkout`, `NEXT_PUBLIC_FEATURE_NEW_CHECKOUT` and `NEW_CHECKOUT_ENABLED` are all `NEW_CHECKOUT`. */
function canonical(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC|EXPO_PUBLIC)_/, "")
    .replace(/^(?:FEATURE|FF|FLAG|ENABLE)_/, "")
    .replace(/_(?:ENABLED|FLAG)$/, "");
}

/** The flag keys on added and deleted lines of a unified diff (`git diff base...head`). */
export function flagChanges(diff: string): FlagChange[] {
  const seen = new Map<string, { added: boolean; removed: boolean; env: boolean; files: Set<string> }>();
  let file = "";
  // `---`/`+++` name the file only in a file's header: in a hunk they are a deleted `-- comment` or an added `++x`.
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      [file, header] = ["", true];
      continue;
    }
    if (header) {
      if (line.startsWith("--- ")) file = line.slice(4).replace(/^a\//, "");
      // A deleted file has `+++ /dev/null`: the old name stays.
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("@@")) header = false;
      continue;
    }
    const sign = line[0];
    if ((sign !== "+" && sign !== "-") || !file || file === "/dev/null" || IGNORED.test(file)) continue;
    for (const { key, env } of keysOf(line.slice(1), file)) {
      const e = seen.get(key) ?? { added: false, removed: false, env: true, files: new Set<string>() };
      e.env &&= env;
      if (sign === "+") e.added = true;
      else e.removed = true;
      e.files.add(file);
      seen.set(key, e);
    }
  }
  // A key and its environment variable are one flag, named by the key the code asks for. Two keys stay
  // two flags, even when they differ only in spelling: a renamed flag is a new one.
  const groups = new Map<string, { names: string[]; added: boolean; removed: boolean; files: Set<string> }>();
  const add = (id: string, key: string, e: { added: boolean; removed: boolean; files: Set<string> }) => {
    const g = groups.get(id) ?? { names: [], added: false, removed: false, files: new Set<string>() };
    g.names.push(key);
    g.added ||= e.added;
    g.removed ||= e.removed;
    for (const f of e.files) g.files.add(f);
    groups.set(id, g);
  };
  for (const [key, e] of seen) if (!e.env) add(key, key, e);
  for (const [key, e] of seen) {
    if (!e.env) continue;
    // After a rename the variable belongs to the key the code asks for now.
    const owners = [...seen].filter(([k, o]) => !o.env && canonical(k) === canonical(key));
    const owner = (owners.find(([, o]) => o.added) ?? owners[0])?.[0];
    add(owner ?? key, key, e);
  }
  return [...groups.values()].map((g) => {
    const [key = "", ...aliases] = g.names;
    return { key, ...(aliases.length ? { aliases } : {}), kind: g.added && g.removed ? "changed" : g.added ? "added" : "removed", files: [...g.files].sort() };
  });
}

/** The candidates of the PR checked out in `repo`; none when git cannot read the diff. */
export function flagChangesIn(repo: string, base: string, head: string): FlagChange[] {
  const r = spawnSync("git", ["-C", repo, "diff", "--no-color", "--no-ext-diff", "-U0", `${base}...${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return r.status === 0 ? flagChanges(r.stdout) : [];
}
