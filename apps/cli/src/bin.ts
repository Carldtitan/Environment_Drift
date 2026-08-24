#!/usr/bin/env node
/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` the
 * first time `node:sqlite` is loaded. IWOMC uses it deliberately - it is how
 * the local store avoids a native dependency - and a warning on every single
 * command teaches people to ignore warnings.
 *
 * Only that one is dropped. Everything else is written out the way Node's own
 * handler would, rather than re-emitted: re-emitting a warning raises the same
 * event again, and this handler would answer its own message forever.
 */
process.removeAllListeners("warning");
process.on("warning", (warning: Error) => {
  if (warning.name === "ExperimentalWarning" && /\bSQLite\b/u.test(warning.message)) return;
  process.stderr.write(
    `(node:${process.pid}) ${warning.name}: ${warning.message}\n${warning.stack ?? ""}\n`,
  );
});

const { runCli } = await import("./cli.js");
const code = await runCli(process.argv.slice(2));
process.exitCode = code;
