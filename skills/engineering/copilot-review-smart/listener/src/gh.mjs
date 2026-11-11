import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MAX_BUFFER = 1024 * 1024;

function typedFieldValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function setBodyField(body, rawField, value, typed) {
  const array = rawField.endsWith("[]");
  const field = array ? rawField.slice(0, -2) : rawField;
  const path = field.replace(/\]$/, "").split(/\[|\]/).filter(Boolean);
  if (path.length === 0) throw new Error(`invalid gh api field: ${rawField}`);

  let target = body;
  for (const part of path.slice(0, -1)) {
    target[part] ??= {};
    target = target[part];
  }
  const key = path.at(-1);
  const fieldValue = typed ? typedFieldValue(value) : value;
  if (array) {
    target[key] ??= [];
    target[key].push(fieldValue);
  } else {
    target[key] = fieldValue;
  }
}

function requestWithStdin(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const collect = (stream, append) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        append(chunk);
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BUFFER) {
          overflow = true;
          child.kill();
        }
      });
    };
    collect(child.stdout, (chunk) => { stdout += chunk; });
    collect(child.stderr, (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code) => {
      if (overflow) {
        reject(new Error(`gh exceeded the ${MAX_BUFFER}-byte output limit`));
      } else if (code !== 0) {
        reject(Object.assign(new Error(stderr.trim() || `gh exited with status ${code}`), { stderr }));
      } else {
        resolve({ stdout });
      }
    });
    child.stdin.end(input);
  });
}

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
    const secretField = values.find((arg) => arg.startsWith("config[secret]="));
    let stdout;
    if (secretField) {
      const body = {};
      const requestArgs = [];
      for (let index = 0; index < values.length; index += 1) {
        const arg = values[index];
        if (arg === "-f" || arg === "-F") {
          const field = values[++index];
          if (field === undefined || !field.includes("=")) {
            throw new Error(`invalid gh api field after ${arg}`);
          }
          const separator = field.indexOf("=");
          setBodyField(body, field.slice(0, separator), field.slice(separator + 1), arg === "-F");
        } else {
          requestArgs.push(arg);
        }
      }
      requestArgs.push("--input", "-");
      ({ stdout } = await requestWithStdin(requestArgs, JSON.stringify(body)));
    } else {
      ({ stdout } = await execFileP("gh", ["api", ...values]));
    }
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (e) {
    throw new Error(`gh failed: ${safeArgs.join(" ")}\n${redact(e.stderr || e.message).trim()}`);
  }
}
