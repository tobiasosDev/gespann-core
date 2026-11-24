#!/usr/bin/env node
import { main } from "./cli.ts";

// `gespann findings | head` closes stdout early; that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`gespann: ${err.message}\n`);
  process.exitCode = 2;
});
