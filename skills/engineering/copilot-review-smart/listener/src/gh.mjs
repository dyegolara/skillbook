import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// GitHub Hook management
// ---------------------------------------------------------------------------
export async function runGh(args) {
  const values = args.map(String);
  const secrets = values
    .filter((arg) => arg.startsWith("config[secret]="))
    .map((arg) => arg.slice("config[secret]=".length))
    .filter(Boolean);
  const redact = (value) => {
    let output = String(value);
    for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
    return output.replace(/config\[secret\]=[^\s\r\n]*/gi, "config[secret]=[REDACTED]");
  };
  const safeArgs = values.map((arg) =>
    arg.startsWith("config[secret]=") ? "config[secret]=[REDACTED]" : redact(arg)
  );
  try {
    const { stdout } = await execFileP("gh", ["api", ...values]);
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (e) {
    throw new Error(`gh failed: ${safeArgs.join(" ")}\n${redact(e.stderr || e.message).trim()}`);
  }
}

