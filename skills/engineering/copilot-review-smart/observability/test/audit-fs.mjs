// Preload for the TUI suite (`node --import ./audit-fs.mjs …`). Records every
// public `node:fs` read/open call so a test can prove the TUI never opens the
// watchdog's state files directly — the API is the only seam. The audit is
// flushed on exit because the preload cannot import anything after the main
// module has started. It is itself not a test file: `node --test` ignores it.
import fs from "node:fs";

const auditPath = process.env.TUI_FS_AUDIT;
const opened = [];

function record(file) {
  try {
    opened.push(String(file));
  } catch {
    // A non-string-ish path is not our concern; the String() above cannot
    // really throw, but never let the audit break the process under test.
  }
}

for (const name of ["readFileSync", "openSync", "readdirSync", "statSync"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function audited(...args) {
    record(args[0]);
    return original.apply(this, args);
  };
}

if (fs.promises) {
  for (const name of ["readFile", "open", "readdir", "stat"]) {
    const original = fs.promises[name];
    if (typeof original !== "function") continue;
    fs.promises[name] = function audited(...args) {
      record(args[0]);
      return original.apply(this, args);
    };
  }
}

process.on("exit", () => {
  if (!auditPath) return;
  try {
    fs.writeFileSync(auditPath, JSON.stringify(opened, null, 2));
  } catch {
    // Best effort: the audit is test scaffolding, never a reason to fail.
  }
});
