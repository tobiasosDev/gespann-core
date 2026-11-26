// Writes the TypeScript scripts as JSON, for the Rust test that checks they stay byte-identical.
// Run from the repo root: node orchestrator/tests/fixtures/gen-scripts.ts > orchestrator/tests/fixtures/scripts.json
import { registerHooks } from "node:module";

// worker.ts imports the yaml package, which none of these scripts use; a stub saves an npm install.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "yaml" ? { url: "data:text/javascript,export const parse = () => { throw new Error('yaml stub'); }; export const stringify = parse;", shortCircuit: true } : next(specifier, context),
});

const sb = await import("../../../src/server/sandbox.ts");
const { installScript } = await import("../../../src/server/worker.ts");

const paths = ["/home/user", "/srv/gespann-sandboxes/gespann-acme-1a2b3c", "/tmp/it's a dir", 'run/"quoted" $HOME `x`'];
const words = ["", "--privileged -v /var/run/docker.sock:/var/run/docker.sock", `sleep  infinity`, `a 'b c' "d 'e'" f""g ''`, " \t lead\nand trail  "];
const installs = [
  { ref: "main", core: "/home/user/gespann/core", url: "https://github.com/tobiasosDev/gespann-core.git", bin: `"$(npm prefix -g)/bin/gespann"` },
  { ref: "v1.2.3; rm -rf / 'x'", core: "/srv/box/gespann/core", url: "https://example.com/it's.git", bin: "/opt/bin/gespann" },
];

const out = {
  q: paths.map((p) => [p, sb.q(p)]),
  words: words.map((w) => [w, sb.words(w)]),
  prelude: paths.map((p) => [p, sb.prelude(p)]),
  record: paths.map((p) => [p, sb.recordScript(p, false), sb.recordScript(p, true)]),
  stopRecord: sb.stopRecordScript(),
  finishRecording: paths.map((p) => [p, sb.finishRecordingScript(p)]),
  screen: paths.map((p) => [p, sb.screenScript(p)]),
  stopScreen: paths.map((p) => [p, sb.stopScreenScript(p)]),
  install: installs.map((i) => [i.ref, i.core, i.url, i.bin, installScript(i.ref, { core: i.core, url: i.url, bin: i.bin })]),
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
