// Asserts that the mock demo produced a complete run folder. Used by CI.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "demo-run";
let ok = true;
for (const f of ["run.json", "events.jsonl", "transcript.md", "plan.md", "agents.json"]) {
  const fp = path.join(dir, f);
  if (!fs.existsSync(fp) || fs.statSync(fp).size === 0) {
    console.error(`missing or empty: ${fp}`);
    ok = false;
  } else {
    console.log(`ok: ${fp}`);
  }
}
const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
if (run.status !== "ok") {
  console.error(`demo run status is ${run.status}, expected ok`);
  ok = false;
}
process.exit(ok ? 0 : 1);
