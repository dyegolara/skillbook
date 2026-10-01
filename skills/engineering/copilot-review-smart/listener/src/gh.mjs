import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// GitHub Hook management
// ---------------------------------------------------------------------------
export async function runGh(args) {
  try {
    const { stdout } = await execFileP("gh", ["api", ...args]);
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (e) {
    throw new Error(`gh failed: ${args.join(" ")}\n${String(e.stderr || e.message).trim()}`);
  }
}


