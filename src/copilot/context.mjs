// Copilot context slice (spine step 9, docs/API.md `src/copilot`).
//
// generateCopilotContext(workspace, { out }) -> [rutas escritas]
//
// Renders the revision-aware graph into a compact, human/agent-readable context
// string and writes it as Copilot instructions: ONE global
// `.github/copilot-instructions.md` plus one instruction file per route, each
// route file declaring its `applyTo` so the context reaches exactly the files
// it concerns.
//
// Everything is derived from the SAME SQLite store the viewer uses (rule 4: one
// source of truth). A render never invents nodes or edges (rule 2), every edge
// cites its evidence {file, lineStart} (rule 1), and EXTRACTED is used only for
// what was read literally in the source (rule 3).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const GLOBAL_FILE = join(".github", "copilot-instructions.md");
const ROUTES_DIR = join(".github", "instructions", "routes");

const DEFAULT_OUT = (workspace) => workspace.dir ?? ".";

/**
 * Render the whole revision-aware graph as one compact text document.
 *
 * The output is derived directly from the store (rule 4) and cites the current
 * revision (rule 5), every node and every edge with its evidence location
 * (rule 1) and the edge nature (rule 3).
 *
 * @param {object} store a GraphStore (the single source of truth).
 * @returns {string} the compact context document.
 */
export function renderGraphContext(store) {
  const nodes = store.findNodes({});
  const edges = store.getEdges({});
  const revision = store.lastRevision() ?? "unknown";

  const byKind = new Map();
  for (const node of nodes) {
    const list = byKind.get(node.kind) ?? [];
    list.push(node);
    byKind.set(node.kind, list);
  }

  const lines = [];
  lines.push("# IAGraph context");
  lines.push(`revision: ${revision}`);
  lines.push(`nodes: ${nodes.length}`);
  lines.push(`edges: ${edges.length}`);
  lines.push(
    "evidence: every edge cites {file:lineStart}; EXTRACTED is read literally in the source, " +
      "INFERRED derives from a rule or resolution, AMBIGUOUS is unresolved",
  );
  lines.push("");

  const repos = nodes.filter((n) => n.kind === "repository");
  if (repos.length > 0) {
    lines.push("## repositories");
    for (const r of [...repos].sort((a, b) => a.id.localeCompare(b.id))) {
      const role = r.metadata?.role ? ` (role: ${r.metadata.role})` : "";
      lines.push(`- ${r.qualifiedName}${role}`);
    }
    lines.push("");
  }

  lines.push("## nodes");
  for (const kind of [...byKind.keys()].sort()) {
    lines.push(`### ${kind}`);
    for (const n of [...byKind.get(kind)].sort((a, b) => a.id.localeCompare(b.id))) {
      const loc = n.file
        ? ` @ ${n.file}${Number.isInteger(n.lineStart) ? `:${n.lineStart}` : ""}`
        : typeof n.route === "string" && n.route.length > 0
          ? ` route=${n.route}`
          : "";
      const span = ` [${n.firstSeenRev}..${n.lastSeenRev}]`;
      lines.push(`- ${n.id}${loc}${span}`);
    }
  }
  lines.push("");

  lines.push("## edges");
  for (const e of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const ev = e.evidence ?? {};
    const rule = e.ruleId ? ` rule=${e.ruleId}` : "";
    const rev = e.observedInRev ? ` (${e.observedInRev})` : "";
    lines.push(
      `- ${e.src} --[${e.kind} ${e.nature}]--> ${e.dst}  @ ${ev.file ?? "?"}:${ev.lineStart ?? "?"}${rev}${rule}`,
    );
  }
  lines.push("");

  const rules = nodes.filter((n) => n.kind === "binding_rule");
  if (rules.length > 0) {
    lines.push("## binding rules");
    for (const r of [...rules].sort((a, b) => a.id.localeCompare(b.id))) {
      const scope = typeof r.scope === "string" && r.scope.length > 0 ? ` scope=${r.scope}` : "";
      const ev = r.evidence?.[0] ?? {};
      const loc = ev.file ? ` @ ${ev.file}:${ev.lineStart ?? "?"}` : "";
      lines.push(`- ${r.id}${scope}${loc}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

/**
 * Render the per-route instruction document for one route node: the endpoint,
 * who consumes it and what it points to, all with evidence citations.
 *
 * @param {object} store a GraphStore.
 * @param {object} node   an endpoint/route node carrying `route` (and `method`).
 * @param {object[]} edges every stored edge (filtered here, never invented).
 * @returns {string} the route instruction body (without frontmatter).
 */
export function renderRouteContext(store, node, edges) {
  const incoming = edges.filter((e) => e.dst === node.id);
  const outgoing = edges.filter((e) => e.src === node.id);
  const revision = store.lastRevision() ?? "unknown";
  const loc = node.file
    ? `${node.file}${Number.isInteger(node.lineStart) ? `:${node.lineStart}` : ""}`
    : "?";

  const lines = [];
  lines.push(`# Route: ${node.qualifiedName}`);
  lines.push(`revision: ${revision}`);
  if (typeof node.method === "string" && node.method.length > 0) lines.push(`method: ${node.method}`);
  lines.push(`route: ${node.route}`);
  lines.push(`endpoint: ${node.id} @ ${loc}`);
  lines.push("");
  lines.push("## consumers");
  if (incoming.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of [...incoming].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${edgeLine(e)}`);
    }
  }
  lines.push("");
  lines.push("## outgoing");
  if (outgoing.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of [...outgoing].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- ${edgeLine(e)}`);
    }
  }
  lines.push("");
  lines.push(
    "Note: only edges with evidence {file:lineStart} from the store are listed; " +
      "nothing here is guessed (rule 2) and EXTRACTED marks only literal source reads (rule 3).",
  );
  return lines.join("\n") + "\n";
}

function edgeLine(e) {
  const ev = e.evidence ?? {};
  const rule = e.ruleId ? ` rule=${e.ruleId}` : "";
  return `${e.src} --[${e.kind} ${e.nature}]--> ${e.dst}  @ ${ev.file ?? "?"}:${ev.lineStart ?? "?"}${rule}`;
}

function frontmatter(applyTo) {
  return `---
applyTo:
  - ${JSON.stringify(applyTo)}
---

`;
}

function slugify(route) {
  return (
    String(route)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "route"
  );
}

/**
 * Generate the Copilot context: the global instructions file plus one
 * instruction file per route, each declaring its `applyTo`.
 *
 * @param {object} workspace a Workspace whose `store` is the single source of
 *   truth (rule 4). Nodes and edges are read straight from that store.
 * @param {{ out?: string }} [opts] `out` is the target directory (defaults to
 *   `workspace.dir`). Files are written under `<out>/.github/...`.
 * @returns {Promise<string[]>} the absolute paths of the written files.
 */
export async function generateCopilotContext(workspace, { out } = {}) {
  const store = workspace?.store;
  if (!store) {
    throw new TypeError(
      "generateCopilotContext: workspace.store is required (rule 4: the Copilot context derives from the same SQLite store)",
    );
  }

  const root = resolve(out ?? DEFAULT_OUT(workspace));
  const edges = store.getEdges({});
  const written = [];

  const global = join(root, GLOBAL_FILE);
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(global, renderGraphContext(store), "utf8");
  written.push(global);

  const routes = store
    .findNodes({})
    .filter((n) => typeof n.route === "string" && n.route.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const node of routes) {
    const target = join(root, ROUTES_DIR, `${slugify(node.route)}.instructions.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, frontmatter(node.route) + renderRouteContext(store, node, edges), "utf8");
    written.push(target);
  }

  return written;
}