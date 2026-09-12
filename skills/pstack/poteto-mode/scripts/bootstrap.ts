import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function writeInstallKey(mode: "prod" | "full" = "prod"): void {
  writeFileSync(installKeyPath, `${mode}:${currentInstallKey()}\n`);
}

export function ensureDependenciesInstalled(): void {
  const installKey = currentInstallKey();
  if (existsSync(commanderPackagePath) && hasCurrentInstallKey(installKey)) {
    return;
  }

  const result = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: scriptsDirectory,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`npm ci exited with status ${result.status}`);
  }
  if (!existsSync(commanderPackagePath)) {
    throw new Error(
      "npm ci --omit=dev completed without installing commander"
    );
  }

  writeInstallKey("prod");

  const restarted = spawnSync(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(restarted.status ?? 1);
}
