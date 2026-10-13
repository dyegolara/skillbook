// Directory entry for `node --test test/`: importing both suites registers
// their tests in one run. Each file also runs on its own, and the repo-level
// `test:copilot-review-smart` script lists them explicitly.
import "./observability.test.mjs";
import "./tui.test.mjs";
