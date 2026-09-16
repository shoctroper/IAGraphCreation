// The git-diff-driven incremental engine (spine step 6, docs/API.md
// `src/incremental`): diff de git -> región afectada -> reanálisis -> upsert.
//
// A commit is turned into a precise mutation of the graph:
//
//   1. `git diff --name-status -M from..to` resolves the changed files and the
//      renames (rename detection, so a `git mv` keeps symbol identity, E4/E5).
//   2. The affected region is computed: the changed files themselves, the files
//      that reference their symbols (callers: a signature change invalidates the
//      callers too, E6) and the whole scope of any binding_rule a changed file
//      falls under (an assembly-scanning registration is a RULE over a domain,
//      so an add/delete/rename inside the domain re-evaluates the rule, F5).
//   3. Only the region is re-parsed, against the full corpus type index (so
//      cross-file implements/binds_implementation resolve exactly as a rebuild
//      would, rule 2) and against the full declared-routes set (so UI calls
//      relink to the endpoints that actually exist, E7).
//   4. The store is reconciled: every node/edge anchored in the region is
//      re-derived and stale ones are dropped (a changed route removes the old
//      endpoint instead of leaving it with a stale route, E2).
//
// The result is that an update touches exactly the affected files and recomputes
// their edges, while the untouched files keep their history (rule 5) — and the
// canonical hash of the resulting graph equals a fresh rebuild (F1/F3/F4/F5).

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createNode,
  createEdge,
  createRevision,
  makeNodeId,
  toPosixPath,
} from "../model/index.mjs";
import { resolveBindingRules } from "../resolve/index.mjs";
import { scanRepository } from "../scanner/index.mjs";
import { createCSharpAnalyzer } from "../analyzers/csharp/index.mjs";
import { createTypeScriptAnalyzer } from "../analyzers/typescript/index.mjs";
import { analyzeContracts } from "../analyzers/contracts/index.mjs";
import { mergeNodes } from "../analyzers/csharp/extract.mjs";

export const INCREMENTAL = "incremental";
export const INCREMENTAL_VERSION = "0.1.0";

export const FILE_EXTRACTOR = "filesystem";
export const FILE_EXTRACTOR_VERSION = "0.1.0";

const CS_RE = /\.cs$/i;
const TS_RE = /\.(ts|mts|cts|tsx)$/i;
const JSON_RE = /\.json$/i;

/**
 * `git diff --name-status -M` between two revisions, parsed into entries and
 * renames. Rename detection is what lets a `git mv` keep its symbols (E4/E5).
 *
 * @returns {{ entries: Array<{status:string,file?:string,from?:string,to?:string}>,
 *            renames: Array<{from:string,to:string}> }}
 */
export function gitDiff(repoPath, from, to) {
  const out = execFileSync(
    "git",
    ["-C", repoPath, "diff", "--name-status", "-M", from, to],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const entries = [];
  const renames = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (/^R\d+$/.test(status)) {
      renames.push({ from: parts[1], to: parts[2] });
      entries.push({ status: "R", from: parts[1], to: parts[2] });
    } else if (parts[1]) {
      entries.push({ status, file: parts[1] });
    }
  }
  return { entries, renames };
}

/** The namespace a qualified type name declares (its name minus the last segment). */
function namespaceOfType(qualifiedName) {
  const parts = String(qualifiedName).split(".");
  parts.pop();
  return parts.join(".");
}

/** The simple type name of a qualified name (its last dot segment). */
function simpleTypeName(qualifiedName) {
  const parts = String(qualifiedName).split(".");
  return parts[parts.length - 1] || null;
}

function addToIndex(map, name, id) {
  let set = map.get(name);
  if (!set) {
    set = new Set();
    map.set(name, set);
  }
  set.add(id);
  return map;
}

function mergeTypeIndex(target, types) {
  for (const key of ["interfaces", "classes"]) {
    for (const [name, ids] of types[key]) {
      for (const id of ids) addToIndex(target[key], name, id);
    }
  }
}

/**
 * The full corpus type index, rebuilt from the store: one entry per declared
 * class/interface, keyed by simple name exactly like the analyzer's `collectTypes`
 * pass. Because the store is the graph's single source of truth (rule 4), the
 * index needs no re-parse of unchanged files.
 */
export function buildTypeIndexFromStore(store) {
  const index = { interfaces: new Map(), classes: new Map() };
  for (const node of store.findNodes({})) {
    if (node.kind !== "class" && node.kind !== "interface") continue;
    const simple = simpleTypeName(node.qualifiedName);
    if (!simple) continue;
    addToIndex(index[node.kind === "interface" ? "interfaces" : "classes"], simple, node.id);
  }
  return index;
}

/**
 * The namespaces declared per file, from the store's type nodes. Computed before
 * any deletion so a removed file's scope membership is still decidable.
 */
function namespacesByFileOf(store) {
  const byFile = new Map();
  for (const node of store.findNodes({})) {
    if (node.kind !== "class" && node.kind !== "interface") continue;
    const ns = namespaceOfType(node.qualifiedName);
    for (const ev of node.evidence ?? []) {
      if (!byFile.has(ev.file)) byFile.set(ev.file, new Set());
      byFile.get(ev.file).add(ns);
    }
  }
  return byFile;
}

/** The namespace declared by a repo-relative file, read from its source. */
function namespaceOfRepoFile(root, rel) {
  try {
    const src = readFileSync(join(root, rel), "utf8");
    const m = src.match(/namespace\s+([A-Za-z_][A-Za-z0-9_.]*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function inNamespace(ns, scope) {
  return ns === scope || ns.startsWith(`${scope}.`);
}

/**
 * The files that live under a rule's scope: every file that declares a type in
 * that assembly/namespace. Scope membership is decidable from the store, so a
 * change inside the domain invalidates the rule without re-parsing.
 */
function scopeFilesOf(namespacesByFile, scope) {
  const files = new Set();
  for (const [file, nss] of namespacesByFile) {
    for (const ns of nss) if (inNamespace(ns, scope)) files.add(file);
  }
  return files;
}

/** Whether a changed file falls under a rule's scope. */
function fileInScope(file, scope, namespacesByFile, root) {
  const nss = namespacesByFile.get(file);
  if (nss) {
    for (const ns of nss) if (inNamespace(ns, scope)) return true;
  }
  const ns = namespaceOfRepoFile(root, file);
  return ns !== null && inNamespace(ns, scope);
}

/**
 * Compute the affected region of a commit: changed files, the files that call
 * or reference their symbols, and every file under an invalidated binding_rule
 * scope. Returns `{ region, dependents, invalidatedRules }`.
 */
export function computeRegion(store, root, { allChanged, namespacesByFile } = {}) {
  const region = new Set(allChanged);
  const dependents = [];

  const changedNodeIds = new Set();
  for (const node of store.findNodes({})) {
    if (node.kind === "repository" || node.kind === "file") continue;
    const frags = node.evidence ?? [];
    if (frags.some((ev) => allChanged.has(ev.file))) changedNodeIds.add(node.id);
  }

  for (const edge of store.getEdges({})) {
    if (changedNodeIds.has(edge.src) || changedNodeIds.has(edge.dst)) {
      region.add(edge.evidence.file);
      dependents.push(edge.evidence.file);
    }
  }

  const invalidatedRules = [];
  for (const rule of store.findNodes({ kind: "binding_rule" })) {
    if (!rule.scope) continue;
    const scopeFiles = scopeFilesOf(namespacesByFile, rule.scope);
    const hit = [...allChanged].some((f) => fileInScope(f, rule.scope, namespacesByFile, root));
    if (hit) {
      invalidatedRules.push({ id: rule.id, scope: rule.scope, file: rule.file });
      for (const f of scopeFiles) region.add(f);
    }
  }

  return { region, dependents, invalidatedRules };
}

/** The final declared routes (`METHOD route`) the region's UI calls resolve against. */
function computeRoutes(store, region, regionEndpointNodes) {
  const routes = new Set();
  for (const ep of store.findNodes({ kind: "endpoint" })) {
    const inRegion = (ep.evidence ?? []).some((ev) => region.has(ev.file));
    if (!inRegion) routes.add(`${ep.method} ${ep.route}`);
  }
  for (const n of regionEndpointNodes) {
    if (n.kind === "endpoint") routes.add(`${n.method} ${n.route}`);
  }
  return routes;
}

/** Deduplicate evidence fragments by `file:lineStart`. */
function mergeFragments(fragments) {
  const seen = new Set();
  const out = [];
  for (const ev of fragments) {
    if (!ev || typeof ev.file !== "string") continue;
    const key = `${ev.file}:${ev.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/**
 * The primary location of a node: its earliest fragment by file/line, exactly
 * as a rebuild's `mergeNodes` would produce it (a partial class keeps the
 * location of its first-declared fragment).
 */
function primaryLocation(fragments) {
  const sorted = [...fragments].sort((a, b) => {
    if (a.file === b.file) return (a.lineStart ?? 0) - (b.lineStart ?? 0);
    return a.file < b.file ? -1 : 1;
  });
  return sorted[0] ?? null;
}

/**
 * Reconcile the store with the region's re-derived nodes and edges:
 *   - nodes/edges anchored in the region are dropped when the region no longer
 *     produces them, refreshed when it still does;
 *   - partial-class nodes keep the evidence of their untouched fragments;
 *   - file nodes and repo->file contains edges follow the new scan.
 */
export function applyRegion(
  store,
  {
    repoId,
    region,
    newRev,
    csNodes,
    csEdges,
    ruleNodes,
    ruleEdges,
    tsEdges,
    contractNodes,
    newFiles,
    scan,
  } = {},
) {
  const reExtracted = new Map();
  for (const node of [...csNodes, ...ruleNodes, ...(contractNodes ?? [])]) {
    reExtracted.set(node.id, node);
  }
  const freshEdges = new Map();
  for (const edge of [...csEdges, ...ruleEdges, ...tsEdges]) freshEdges.set(edge.id, edge);

  // ---- nodes -------------------------------------------------------------
  const nodeUpserts = [];
  const nodeRemovals = [];
  const handled = new Set();
  for (const node of store.findNodes({})) {
    if (node.kind === "repository" || node.kind === "file") continue;
    const frags = node.evidence ?? [];
    if (!frags.some((ev) => region.has(ev.file))) continue;
    handled.add(node.id);
    const keptFrags = frags.filter((ev) => !region.has(ev.file));
    const fresh = reExtracted.get(node.id);
    if (fresh) {
      const evidence = mergeFragments([...keptFrags, ...(fresh.evidence ?? [])]);
      const loc = primaryLocation(evidence);
      nodeUpserts.push({
        ...node,
        ...fresh,
        id: node.id,
        evidence,
        file: loc ? loc.file : fresh.file,
        lineStart: loc ? loc.lineStart : fresh.lineStart,
        lineEnd: loc && loc.lineEnd !== undefined ? loc.lineEnd : fresh.lineEnd,
      });
    } else if (keptFrags.length > 0) {
      nodeUpserts.push({ ...node, evidence: keptFrags });
    } else {
      nodeRemovals.push(node.id);
    }
  }
  for (const [id, fresh] of reExtracted) {
    if (!handled.has(id)) nodeUpserts.push(fresh);
  }

  // ---- edges -------------------------------------------------------------
  const edgeRemovals = [];
  for (const edge of store.getEdges({})) {
    if (region.has(edge.evidence.file) && !freshEdges.has(edge.id)) edgeRemovals.push(edge.id);
  }

  for (const id of nodeRemovals) store.removeNodeOnly(id);
  for (const id of edgeRemovals) store.removeEdge(id);
  if (nodeUpserts.length > 0) store.upsertNodes(nodeUpserts, newRev);
  if (freshEdges.size > 0) store.upsertEdges([...freshEdges.values()], newRev);

  // ---- file nodes + repo->file contains edges for the new scan -----------
  const fileNodes = [];
  const containsEdges = [];
  for (const rel of scan.files) {
    const id = makeNodeId("file", rel);
    fileNodes.push(
      createNode({
        kind: "file",
        name: basename(rel),
        qualifiedName: rel,
        file: rel,
        lineStart: 1,
        evidence: [{ file: rel, lineStart: 1, rev: newRev }],
        rev: newRev,
      }),
    );
    containsEdges.push(
      createEdge({
        src: repoId,
        dst: id,
        kind: "contains",
        nature: "EXTRACTED",
        extractor: FILE_EXTRACTOR,
        extractorVersion: FILE_EXTRACTOR_VERSION,
        evidence: { file: rel, lineStart: 1, rev: newRev },
        observedInRev: newRev,
      }),
    );
  }
  if (fileNodes.length > 0) store.upsertNodes(fileNodes, newRev);
  if (containsEdges.length > 0) store.upsertEdges(containsEdges, newRev);
  for (const node of store.findNodes({ kind: "file" })) {
    if (node.kind === "file" && !newFiles.has(node.file)) store.removeNodeOnly(node.id);
  }
}

/**
 * Apply the git-diff-driven incremental update to ONE repository.
 *
 * @param {import("../store/graph-store.mjs").GraphStore} store
 * @param {{ path: string, role: string }} repo
 * @param {{ from?: string, to?: string }} opts
 * @returns {Promise<object>} the UpdateReport (changedFiles, reanalyzedFiles,
 *   renamed, invalidationReason, degradedToRebuild, invalidatedRules, revisions).
 */
export async function updateRepository(store, repo, { from, to } = {}) {
  const root = resolve(repo.path);
  const scan = await scanRepository({ path: root, rev: to });
  if (!scan.rev) throw new Error(`update: no git revision resolvable for ${root}`);
  const newRev = scan.rev;
  const prevRev = from ?? (await store.lastRevision());
  if (!prevRev) {
    throw new Error(`update: no previous revision to diff against (${root})`);
  }
  const repoId = makeNodeId("repository", toPosixPath(root));
  const newFiles = new Set(scan.files);

  const { entries, renames } = gitDiff(root, prevRev, newRev);
  const renamesMap = new Map(renames.map((r) => [r.from, r.to]));

  // Every path the commit touched, both sides of a rename.
  const allChanged = new Set([
    ...entries.filter((e) => e.status !== "R").map((e) => e.file),
    ...renames.map((r) => r.from),
    ...renames.map((r) => r.to),
  ]);
  const changedFiles = [...allChanged].sort();
  const deletedSet = new Set([
    ...entries.filter((e) => e.status === "D" && !renamesMap.has(e.file)).map((e) => e.file),
    ...renames.map((r) => r.from),
  ]);

  // Namespaces are captured before any removal so deleted/renamed files can
  // still decide rule-scope membership.
  const namespacesByFile = namespacesByFileOf(store);

  const { region, invalidatedRules } = computeRegion(store, root, {
    allChanged,
    namespacesByFile,
  });

  const reasonParts = [];
  if (changedFiles.length > 0) reasonParts.push(`${changedFiles.length} file(s) changed by git`);
  if (region.size > changedFiles.length) {
    reasonParts.push(`${region.size} file(s) in the affected region`);
  }
  if (invalidatedRules.length > 0) {
    reasonParts.push(`${invalidatedRules.length} binding_rule scope(s) invalidated`);
  }

  // ---- 1. rename remap: symbol identity survives a `git mv` (E4/E5, rule 6) --
  if (renamesMap.size > 0) {
    for (const node of store.findNodes({})) {
      if (node.kind === "repository" || node.kind === "file") continue;
      const movedTo = renamesMap.get(node.file);
      if (movedTo) {
        store.upsertNodes(
          [
            {
              ...node,
              file: movedTo,
              evidence: (node.evidence ?? []).map((ev) =>
                ev.file === node.file ? { ...ev, file: movedTo } : ev,
              ),
            },
          ],
          newRev,
        );
      }
    }
  }

  // ---- 2. drop nodes that lived ONLY in deleted files (non-cascade, before
  //         the type index is built so deleted types no longer resolve) -------
  for (const node of store.findNodes({})) {
    if (node.kind === "repository") continue;
    const frags = node.evidence ?? [];
    if (frags.length === 0) continue;
    if (frags.every((ev) => deletedSet.has(ev.file))) {
      store.removeNodeOnly(node.id);
    }
  }

  // ---- 3. full corpus type index (store) + the region's own declarations ----
  const index = buildTypeIndexFromStore(store);
  const csAnalyzer = await createCSharpAnalyzer();
  const tsAnalyzer = await createTypeScriptAnalyzer();

  const regionFiles = [...region].filter((f) => newFiles.has(f));
  const csNodes = [];
  const csEdges = [];
  const csObservations = [];
  const tsEdges = [];

  const csFiles = regionFiles.filter((f) => CS_RE.test(f));
  const csSources = [];
  for (const file of csFiles) {
    const source = await readFile(join(root, file), "utf8");
    csSources.push([file, source]);
    mergeTypeIndex(index, csAnalyzer.collectTypes({ source }));
  }
  for (const [file, source] of csSources) {
    const out = csAnalyzer.extract({ source, file, rev: newRev, index });
    csNodes.push(...out.nodes);
    csEdges.push(...out.edges);
    csObservations.push(...(out.observations ?? []));
  }
  const mergedCsNodes = mergeNodes(csNodes);
  const resolution = resolveBindingRules({ observations: csObservations, rev: newRev });
  const ruleNodes = resolution.nodes;
  const ruleEdges = resolution.edges;

  // Contract files in the region: a changed OpenAPI spec re-derives its
  // endpoint nodes (acceptance J1), exactly like the C# region re-derives its
  // own. The nodes flow into applyRegion so stale contract routes drop.
  const contractNodes = [];
  const contractFiles = regionFiles.filter((f) => JSON_RE.test(f));
  for (const file of contractFiles) {
    const out = await analyzeContracts({ files: [file], root, rev: newRev });
    contractNodes.push(...out.nodes);
  }

  // Routes: the region's re-derived endpoints replace the store's stale ones, so
  // UI calls relink against what actually exists (E2/E7).
  const routes = computeRoutes(store, region, [...mergedCsNodes, ...contractNodes]);

  const tsFiles = regionFiles.filter((f) => TS_RE.test(f));
  for (const file of tsFiles) {
    const source = await readFile(join(root, file), "utf8");
    const out = tsAnalyzer.extract({ source, file, rev: newRev, routes });
    tsEdges.push(...out.edges);
  }

  // ---- 4. reconcile the store with the re-derived region --------------------
  applyRegion(store, {
    repoId,
    region,
    newRev,
    csNodes: mergedCsNodes,
    csEdges,
    ruleNodes,
    ruleEdges,
    tsEdges,
    contractNodes,
    newFiles,
    scan,
  });

  store.recordRevision(createRevision({ sha: newRev, parent: prevRev }));

  return {
    changedFiles: [...new Set(changedFiles)].sort(),
    reanalyzedFiles: [...regionFiles].sort(),
    renamed: renames.map((r) => ({ ...r })),
    invalidationReason: reasonParts.join("; ") || "no semantic changes to apply",
    degradedToRebuild: false,
    invalidatedRules,
    revisions: [newRev],
  };
}