import { runFuseboxCli } from "./cli/fuseboxCli.js";

void runFuseboxCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
