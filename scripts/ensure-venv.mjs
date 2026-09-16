import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venvPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const requirements = path.join(root, "requirements.txt");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(venvPython)) {
  console.log("[cookieless-session-lab] creating .venv");
  run("python3", ["-m", "venv", ".venv"]);
}

console.log("[cookieless-session-lab] installing Python dependencies");
run(venvPython, ["-m", "pip", "install", "-q", "-r", requirements]);
