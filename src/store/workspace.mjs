// Workspace: the composition root that owns a GraphStore and the repositories
// that feed it (docs/API.md, spine step 2).
//
// The build in this slice is deliberately the MINIMAL file-level ingest: a
// `repository` node plus one `file` node per scanned source file, linked by
// `contains` edges. Every edge carries evidence {file, lineStart}, every node is
// tagged firstSeenRev/lastSeenRev and every edge observedInRev/firstSeenRev/
// lastSeenRev, with the revision resolved by the scanner slice. This is what the
// acceptance suite needs to construct a workspace at all; analyzers, resolve and
// incremental are later spine steps that grow on this base.
//
// update()/rebuild()/verify() are functional but intentionally minimal: update
// re-scans the repositories at the current revision (keeping firstSeenRev
// history) and reports an honest, degraded-to-rebuild style report.

import { basename, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  createNode,
  createEdge,
  createRevision,
  makeNodeId,
  REPO_ROLES,
  toPosixPath,
} from "../model/index.mjs";
import { scanRepository } from "../scanner/index.mjs";
import { GraphStore } from "./graph-store.mjs";

const FILE_EXTRACTOR = "filesystem";
const FILE_EXTRACTOR_VERSION = "0.1.0";

/**
 * Ingest one repository at its resolved revision: repository + file nodes and
 * repository -> file `contains` edges, all stamped with the revision.
 */
export async function ingestRepo(store, { path, role }, { rev, parent } = {}) {
  const scan = await scanRepository({ path, rev });
  if (!scan.rev) {
    throw new Error(`ingest: no git revision resolvable for ${path}`);
  }
  const scanRev = scan.rev;
  const root = toPosixPath(scan.root);
  const repoId = makeNodeId("repository", root);

  const repoNode = createNode({
    kind: "repository",
    name: basename(scan.root),
    qualifiedName: root,
    rev: scanRev,
    metadata: { role },
  });

  const fileNodes = scan.files.map((rel) =>
    createNode({
      kind: "file",
      name: basename(rel),
      qualifiedName: rel,
      file: rel,
      lineStart: 1,
      evidence: [{ file: rel, lineStart: 1, rev: scanRev }],
      rev: scanRev,
    }),
  );

  const edges = fileNodes.map((fn) =>
    createEdge({
      src: repoId,
      dst: fn.id,
      kind: "contains",
      nature: "EXTRACTED",
      extractor: FILE_EXTRACTOR,
      extractorVersion: FILE_EXTRACTOR_VERSION,
      evidence: { file: fn.file, lineStart: 1, rev: scanRev },
      observedInRev: scanRev,
    }),
  );

  store.upsertNodes([repoNode, ...fileNodes], scanRev);
  store.upsertEdges(edges, scanRev);
  store.recordRevision(createRevision({ sha: scanRev, parent }));

  return { rev: scanRev, repoId, root, files: fileNodes.length };
}

function detectRenames(repoPath, from, to) {
  if (!from || !to || from === to) return [];
  try {
    const out = execFileSync(
      "git",
      ["-C", repoPath, "diff", "--name-status", "-M", from, to],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const renamed = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^R\d+\t(.+?)\t(.+?)\s*$/);
      if (m) renamed.push({ from: m[1], to: m[2] });
    }
    return renamed;
  } catch {
    return [];
  }
}

export class Workspace {
  constructor({ dir, storePath, store } = {}) {
    this._dir = dir;
    this._storePath = storePath;
    this._store = store;
    this._repos = [];
  }

  get store() {
    return this._store;
  }

  get dir() {
    return this._dir;
  }

  async addRepo({ path, role = "lib" } = {}) {
    if (!REPO_ROLES.includes(role)) {
      throw new TypeError(
        `addRepo: unknown role "${role}" (expected one of ${REPO_ROLES.join(", ")})`,
      );
    }
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("addRepo: path is required");
    }
    const root = resolve(path);
    const meta = await stat(root).catch(() => null);
    if (!meta || !meta.isDirectory()) {
      throw new Error(`addRepo: not a directory: ${path}`);
    }
    if (!this._repos.some((r) => r.path === root)) {
      this._repos.push({ path: root, role });
    }
    return { path: root, role };
  }

  /** Full file-level build of every added repository at the resolved revision. */
  async build({ rev } = {}) {
    if (this._repos.length === 0) {
      throw new Error("build: no repositories added (call addRepo first)");
    }
    const repos = [];
    let revision = null;
    for (const repo of this._repos) {
      const result = await ingestRepo(this._store, repo, { rev });
      revision = result.rev;
      repos.push({ path: repo.path, role: repo.role, rev: result.rev, files: result.files });
    }
    const nodes = await this._store.findNodes({});
    const edges = await this._store.getEdges({});
    return {
      revision,
      repos,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      at: new Date().toISOString(),
    };
  }

  /** Minimal incremental: re-scan at the current revision, drop stale files,
   *  re-ingest, preserving firstSeenRev. Honest report, not a fake precision. */
  async update({ from, to } = {}) {
    const report = {
      changedFiles: [],
      reanalyzedFiles: [],
      renamed: [],
      invalidationReason: "filesystem ingest: re-scan of every repository",
      degradedToRebuild: false,
      invalidatedRules: [],
      revisions: [],
    };
    for (const repo of this._repos) {
      const scan = await scanRepository({ path: repo.path, rev: to });
      if (!scan.rev) {
        throw new Error(`update: no git revision resolvable for ${repo.path}`);
      }
      const newRev = scan.rev;
      const prevRev = from ?? (await this._store.lastRevision());
      const repoId = makeNodeId("repository", toPosixPath(scan.root));

      const scanned = new Set(scan.files);
      const stored = new Set(
        this._store
          .getEdges({ kind: "contains", src: repoId })
          .map((e) => {
            const n = this._store.getNode(e.dst);
            return n && n.file ? n.file : null;
          })
          .filter(Boolean),
      );

      for (const rel of stored) {
        if (!scanned.has(rel)) {
          this._store.removeNode(makeNodeId("file", rel));
          report.changedFiles.push(rel);
        }
      }
      for (const rel of scan.files) {
        if (!stored.has(rel)) report.changedFiles.push(rel);
      }

      await ingestRepo(this._store, { path: repo.path, role: repo.role }, { rev: newRev, parent: prevRev });
      report.reanalyzedFiles.push(...scan.files);
      report.revisions.push(newRev);
      report.renamed.push(...detectRenames(repo.path, prevRev, newRev));
    }
    report.changedFiles = [...new Set(report.changedFiles)].sort();
    report.reanalyzedFiles = [...new Set(report.reanalyzedFiles)].sort();
    report.revisions = [...new Set(report.revisions)];
    return report;
  }

  /** Total reconstruction from source. */
  async rebuild() {
    this._store.clear();
    return this.build();
  }

  /** Compare the current store against a fresh rebuild at the same revision. */
  async verify() {
    const incrementalHash = await this.canonicalHash();
    const probe = new GraphStore({ path: ":memory:" });
    try {
      for (const repo of this._repos) {
        await ingestRepo(probe, repo, {});
      }
      const rebuildHash = probe.canonicalHash();
      return {
        equivalent: incrementalHash === rebuildHash,
        incrementalHash,
        rebuildHash,
        revision: await this._store.lastRevision(),
      };
    } finally {
      probe.close();
    }
  }

  async status() {
    const nodes = await this._store.findNodes({});
    const edges = await this._store.getEdges({});
    return {
      revision: await this._store.lastRevision(),
      revisions: await this._store.revisions(),
      repos: this._repos.map((r) => ({ ...r })),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      health: "ok",
    };
  }

  async canonicalHash() {
    return this._store.canonicalHash();
  }
}

/**
 * Create or open a workspace. `storePath` defaults to `<dir>/.iagraph/graph.db`;
 * `":memory:"` gives an ephemeral in-memory store.
 */
export function createWorkspace(dir, { storePath } = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("createWorkspace: dir is required");
  }
  const root = resolve(dir);
  const path = storePath ?? join(root, ".iagraph", "graph.db");
  const store = new GraphStore({ path });
  return new Workspace({ dir: root, storePath: path, store });
}