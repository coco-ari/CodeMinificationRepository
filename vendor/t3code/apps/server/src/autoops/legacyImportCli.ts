import { runLegacyImportCli } from "./legacyImport.ts";
// Dedicated bundle entry: import.meta.url guards in a shared chunk cannot
// identify the tiny entry wrapper emitted by the upstream bundler.
runLegacyImportCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
