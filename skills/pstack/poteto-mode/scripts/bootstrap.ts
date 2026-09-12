import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const scriptsDirectory = import.meta.dirname;
const nodeModulesDirectory = join(scriptsDirectory, "node_modules");
const commanderPackagePath = join(
  nodeModulesDirectory,
  "commander",
  "package.json"
);
const installKeyPath = join(
  nodeModulesDirectory,
  ".poteto-mode-tools-install-key"
);
const installLockPath = join(scriptsDirectory, ".poteto-mode-tools-install.lock");
const lockWait = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};
function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function clearStaleInstallLock(): boolean {
  try {
    const content = readFileSync(installLockPath, "utf8");
    const match = /^pid:(\d+)$/m.exec(content);
    if (match === null) return false;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0 || isLivePid(pid)) return false;
    unlinkSync(installLockPath);
    return true;
  } catch {
    return false;
  }
}
function withInstallLock<T>(run: () => T): T {
  const startedAt = Date.now();
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random()}`;
  const ownerRecord = `pid:${process.pid}\ntoken:${ownerToken}\n`;
  let lockFd: number | null = null;
  while (lockFd === null) {
    try {
      lockFd = openSync(installLockPath, "wx");
      writeSync(lockFd, ownerRecord);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if (clearStaleInstallLock()) continue;
      if (Date.now() - startedAt > 120_000)
        throw new Error(
          "timed out waiting for dependency bootstrap lock; remove .poteto-mode-tools-install.lock if no install is running"
        );
      lockWait(100);
    }
  }
  try {
    return run();
  } finally {
    try {
      unlinkSync(installLockPath);
    } catch {}
    closeSync(lockFd);
  }
}

function currentInstallKey(): string {
  return createHash("sha256")
    .update(readFileSync(join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(readFileSync(join(scriptsDirectory, "package-lock.json")))
    .digest("hex");
}

function hasCurrentInstallKey(installKey: string): boolean {
  if (!existsSync(installKeyPath)) return false;
  const recorded = readFileSync(installKeyPath, "utf8").trim();
  return recorded === installKey || recorded === `prod:${installKey}` || recorded === `full:${installKey}`;
}

function recordedInstallMode(): "prod" | "full" | null {
  if (!existsSync(installKeyPath)) return null;
  const recorded = readFileSync(installKeyPath, "utf8").trim();
  if (recorded.startsWith("full:")) return "full";
  if (recorded !== "") return "prod";
  return null;
}

export function writeInstallKey(mode: "prod" | "full" = "prod"): void {
  writeFileSync(installKeyPath, `${mode}:${currentInstallKey()}\n`);
}

export function ensureDependenciesInstalled(): void {
  let shouldRestart = false;
  withInstallLock(() => {
    const installKey = currentInstallKey();
    if (existsSync(commanderPackagePath) && hasCurrentInstallKey(installKey)) {
      return;
    }

    const mode =
      existsSync(commanderPackagePath) && recordedInstallMode() === "full"
        ? "full"
        : "prod";
    const args =
      mode === "full"
        ? ["ci", "--no-audit", "--no-fund"]
        : ["ci", "--omit=dev", "--no-audit", "--no-fund"];
    const result = spawnSync("npm", args, {
      cwd: scriptsDirectory,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      throw new Error(
        `npm ${args.join(" ")} exited with status ${result.status}`
      );
    }
    if (!existsSync(commanderPackagePath)) {
      throw new Error(
        `npm ${args.join(" ")} completed without installing commander`
      );
    }

    writeInstallKey(mode);
    shouldRestart = true;
  });
  if (!shouldRestart) return;
  const restarted = spawnSync(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exit(restarted.status ?? 1);
}
