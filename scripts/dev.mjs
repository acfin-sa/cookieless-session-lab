import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvPython = path.join(root, ".venv", "bin", "python");
const envFile = path.join(root, ".env");
const envExample = path.join(root, ".env.example");

if (!existsSync(venvPython)) {
  spawnSync(process.execPath, [path.join(root, "scripts/ensure-venv.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
}

const esbuildBin = path.join(root, "node_modules", ".bin", "esbuild");

if (!existsSync(envFile)) {
  console.warn(
    `[cookieless-session-lab] missing .env — copy ${envExample} to .env and fill secrets before login/Looker will work.`
  );
}

spawnSync(esbuildBin, [
  "app/static/js/src/lab.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--outfile=app/static/js/dist/lab.js",
  "--sourcemap",
], {
  cwd: root,
  stdio: "inherit",
});

const children = [];

function start(label, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }
    console.log(`[${label}] exited ${code}`);
    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill("SIGTERM");
      }
    }
    process.exit(code ?? 1);
  });
  children.push(child);
}

start("js", esbuildBin, [
  "app/static/js/src/lab.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--outfile=app/static/js/dist/lab.js",
  "--sourcemap",
  "--watch",
]);

start("py", venvPython, [
  "-m",
  "uvicorn",
  "web:app",
  "--app-dir",
  "app",
  "--reload",
  "--host",
  "localhost",
  "--port",
  "3000",
]);

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
