// Pinned outcome evaluator for the governed Goal (RFC-G1 v3 §6, §8).
//
// Runs the acceptance suite and reports how many of the pinned cases pass.
// GOV pins this script; the Goal's progress is its `progress` field. It never
// writes to the graph, the repo or the ledger — it only observes.
//
//   node tests/acceptance/evaluate.mjs
//   -> {"iagraph_acceptance_passing": n, "progress": n, "total": 62, "failing": [...]}
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("../../", import.meta.url).pathname;
const TOTAL = 62;
const report = join(tmpdir(), `iagraph-acceptance-${process.pid}.json`);

// The acceptance suite runs under its own config: the default one restricts
// `include` to tests/unit, which made this evaluator match zero files and
// report a blameless 0/62 for several attempts. See the collection guard below.
const run = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.acceptance.mjs",
   "--reporter=json", `--outputFile=${report}`],
  { cwd: ROOT, encoding: "utf8", timeout: 3_600_000, stdio: ["ignore", "pipe", "pipe"] },
);

let passing = 0;
const failing = [];

if (existsSync(report)) {
  try {
    const data = JSON.parse(readFileSync(report, "utf8"));
    for (const file of data.testResults ?? []) {
      for (const t of file.assertionResults ?? []) {
        const name = (t.fullName || t.title || "").trim();
        // A skipped case is NOT a passing case. An absent corpus must never
        // inflate progress.
        if (t.status === "passed") passing += 1;
        else failing.push({ case: name.slice(0, 120), status: t.status });
      }
    }
  } catch (err) {
    failing.push({ case: "<evaluator>", status: `unparseable report: ${err.message}` });
  }
  rmSync(report, { force: true });
} else {
  // The suite could not even produce a report: everything is failing, which is
  // the correct answer on an empty tree.
  const why = (run.stderr || run.stdout || "no output").trim().split("\n").slice(-4).join(" | ");
  failing.push({ case: "<suite did not run>", status: why.slice(0, 400) });
}

// Collection guard. A run that collects fewer cases than the pinned total is
// NOT a result of zero: it means the suite did not run as intended, and
// reporting a calm 0 hides that from the Goal. This happened for real - a
// config change made the filter match no files, and several attempts were
// evaluated against silence. An evaluator that cannot see its own cases must
// say so loudly rather than blame the implementation.
const collected = passing + failing.length;
if (collected < TOTAL) {
  failing.unshift({
    case: "<evaluator collected %d of %d cases>".replace("%d", collected).replace("%d", TOTAL),
    status: "COLLECTION_INCOMPLETE — the acceptance suite did not run in full; "
          + "progress below is not trustworthy",
  });
  passing = 0;
}

console.log(JSON.stringify({
  iagraph_acceptance_passing: passing,
  progress: passing,
  total: TOTAL,
  collected,
  failing: failing.slice(0, 25),
}));
