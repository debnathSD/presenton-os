// Runs the shared conformance kit against every registered adapter.

import fs from "node:fs";
import path from "node:path";
import { setupRegistry, HERE } from "./setup.mjs";
import { runConformance } from "../core/conformance.mjs";
import { fixtures } from "../core/fixtures.mjs";

const { registry } = setupRegistry();
const summary = [];
let failed = 0;
for (const m of registry.list()) {
  const { results } = runConformance(registry.get(m.id), fixtures);
  const fails = results.filter((r) => !r.pass);
  failed += fails.length;
  summary.push({ adapter: m.id, checks: results.length, passed: results.length - fails.length, failures: fails });
  console.log(`${m.id.padEnd(18)} ${results.length - fails.length}/${results.length} checks passed`);
  for (const f of fails) console.log(`   FAIL [${f.fixture}] ${f.check}: ${f.detail ?? ""}`.slice(0, 400));
}
fs.mkdirSync(path.join(HERE, "out"), { recursive: true });
fs.writeFileSync(path.join(HERE, "out/conformance.json"), JSON.stringify(summary, null, 2));
process.exitCode = failed ? 1 : 0;
