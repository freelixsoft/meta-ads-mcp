#!/usr/bin/env node
/**
 * Runs the MCP server and the dashboard's Vite dev server together.
 *
 * A hand-rolled spawner rather than `concurrently` on purpose: adding a root
 * devDependency for this would churn package-lock.json and grow the surface
 * `npm audit --audit-level=high --omit=dev` has to stay clean against, for
 * something Node does in forty lines. Cross-platform, because npm resolves the
 * shim itself.
 *
 * Either process exiting stops the other, so a crashed server never leaves a
 * Vite dev server proxying to a dead port.
 */
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

/**
 * On Windows the child is a cmd.exe wrapper around npm, which is itself a
 * wrapper around the real process, so child.kill() reaps the shell and leaves
 * tsx or vite holding its port. taskkill /T walks the tree.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

const targets = [
  { name: "server", script: "dev" },
  { name: "web", script: "web:dev" },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  process.exitCode = code;
}

for (const target of targets) {
  const child = spawn(npm, ["run", target.script], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: isWindows,
  });
  children.push(child);
  process.stdout.write(`[${target.name}] npm run ${target.script}\n`);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `[${target.name}] exited (${signal ?? code}); stopping the other process\n`,
    );
    shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    process.stderr.write(`[${target.name}] failed to start: ${error.message}\n`);
    shutdown(1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}
