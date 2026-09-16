// SQLite-backed GraphStore (docs/API.md, spine step 2).
//
// node:sqlite is the persistence engine: WAL journaling, one table per entity,
// deterministic id derivation from the canonical model, and validation of every
// mutation against the model invariants before anything is written. The store is
// the single source of truth the viewer and Copilot derive from (rule 4).
//
// Revision-awareness is not optional here (rule 5): upserts carry the revision
// they were observed at, collisions preserve `firstSeenRev`, and every read
// returns nodes/edges in their canonical field shape so the canonical hash is
// stable across builds of the same revision.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertValidNode,
  assertValidEdge,
  makeNodeId,
  makeEdgeId,
  graphCanonicalHash,
} from "../model/index.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS revisions (
  sha TEXT PRIMARY KEY,
  parent TEXT,
  at TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file TEXT,
  line_start INTEGER,
  line_end INTEGER,
  route TEXT,
  method TEXT,
  scope TEXT,
  first_seen_rev TEXT NOT NULL,
  last_seen_rev TEXT NOT NULL,
  evidence TEXT,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  nature TEXT NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  evidence TEXT NOT NULL,
  observed_in_rev TEXT NOT NULL,
  first_seen_rev TEXT NOT NULL,
  last_seen_rev TEXT NOT NULL,
  rule_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_nature ON edges(nature);
`;

const NODE_FILTER_COLUMNS = {
  id: "id",
  kind: "kind",
  name: "name",
  qualifiedName: "qualified_name",
  file: "file",
  route: "route",
  method: "method",
  scope: "scope",
};

const EDGE_FILTER_COLUMNS = {
  id: "id",
  src: "src",
  dst: "dst",
  kind: "kind",
  nature: "nature",
  ruleId: "rule_id",
};

function rowToNode(row) {
  const node = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    firstSeenRev: row.first_seen_rev,
    lastSeenRev: row.last_seen_rev,
  };
  if (row.file !== null) node.file = row.file;
  if (row.line_start !== null) node.lineStart = row.line_start;
  if (row.line_end !== null) node.lineEnd = row.line_end;
  if (row.route !== null) node.route = row.route;
  if (row.method !== null) node.method = row.method;
  if (row.scope !== null) node.scope = row.scope;
  if (row.evidence !== null) node.evidence = JSON.parse(row.evidence);
  if (row.metadata !== null) node.metadata = JSON.parse(row.metadata);
  return node;
}

function rowToEdge(row) {
  const edge = {
    id: row.id,
    src: row.src,
    dst: row.dst,
    kind: row.kind,
    nature: row.nature,
    extractor: row.extractor,
    extractorVersion: row.extractor_version,
    evidence: JSON.parse(row.evidence),
    observedInRev: row.observed_in_rev,
    firstSeenRev: row.first_seen_rev,
    lastSeenRev: row.last_seen_rev,
  };
  if (row.rule_id !== null) edge.ruleId = row.rule_id;
  if (row.metadata !== null) {
    edge.metadata = JSON.parse(row.metadata);
    if (edge.metadata.route !== undefined) edge.route = edge.metadata.route;
    if (edge.metadata.method !== undefined) edge.method = edge.metadata.method;
  }
  return edge;
}

export class GraphStore {
  constructor({ path = ":memory:" } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this._path = path;
    this._db = new DatabaseSync(path);
    this._db.exec("PRAGMA journal_mode = WAL;");
    this._db.exec("PRAGMA synchronous = NORMAL;");
    this._db.exec("PRAGMA foreign_keys = ON;");
    this._db.exec(SCHEMA);
  }

  get path() {
    return this._path;
  }

  close() {
    try {
      this._db.close();
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------- mutations

  /**
   * Insert or refresh nodes, stamped at `rev`. An existing node keeps its
   * `firstSeenRev` and advances `lastSeenRev` (rule 5). Every node is validated
   * against the model invariants before it is persisted.
   */
  upsertNodes(nodes, rev) {
    const read = this._db.prepare("SELECT first_seen_rev FROM nodes WHERE id = ?");
    const upsert = this._db.prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file, line_start, line_end,
                         route, method, scope, first_seen_rev, last_seen_rev,
                         evidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        qualified_name = excluded.qualified_name,
        file = excluded.file,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        route = excluded.route,
        method = excluded.method,
        scope = excluded.scope,
        first_seen_rev = excluded.first_seen_rev,
        last_seen_rev = excluded.last_seen_rev,
        evidence = excluded.evidence,
        metadata = excluded.metadata
    `);
    let count = 0;
    for (const raw of nodes) {
      const id = raw.id ?? makeNodeId(raw.kind, raw.qualifiedName);
      const existing = read.get(id);
      const firstSeenRev = existing ? existing.first_seen_rev : (raw.firstSeenRev ?? rev);
      const lastSeenRev = rev ?? raw.lastSeenRev ?? firstSeenRev;
      const node = { ...raw, id, firstSeenRev, lastSeenRev };
      assertValidNode(node);
      upsert.run(
        id,
        node.kind,
        node.name,
        node.qualifiedName,
        node.file ?? null,
        node.lineStart ?? null,
        node.lineEnd ?? null,
        node.route ?? null,
        node.method ?? null,
        node.scope ?? null,
        node.firstSeenRev,
        node.lastSeenRev,
        node.evidence !== undefined ? JSON.stringify(node.evidence) : null,
        node.metadata !== undefined ? JSON.stringify(node.metadata) : null,
      );
      count += 1;
    }
    return count;
  }

  /**
   * Insert or refresh edges, stamped at `rev`. An existing edge keeps its
   * `firstSeenRev` and advances `observedInRev`/`lastSeenRev` (rule 5).
   */
  upsertEdges(edges, rev) {
    const read = this._db.prepare("SELECT first_seen_rev FROM edges WHERE id = ?");
    const upsert = this._db.prepare(`
      INSERT INTO edges (id, src, dst, kind, nature, extractor, extractor_version,
                         evidence, observed_in_rev, first_seen_rev, last_seen_rev,
                         rule_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        src = excluded.src,
        dst = excluded.dst,
        kind = excluded.kind,
        nature = excluded.nature,
        extractor = excluded.extractor,
        extractor_version = excluded.extractor_version,
        evidence = excluded.evidence,
        observed_in_rev = excluded.observed_in_rev,
        first_seen_rev = excluded.first_seen_rev,
        last_seen_rev = excluded.last_seen_rev,
        rule_id = excluded.rule_id,
        metadata = excluded.metadata
    `);
    let count = 0;
    for (const raw of edges) {
      const id =
        raw.id ??
        makeEdgeId({
          src: raw.src,
          dst: raw.dst,
          kind: raw.kind,
          evidence: raw.evidence,
          ruleId: raw.ruleId,
        });
      const existing = read.get(id);
      const observedInRev = rev ?? raw.observedInRev ?? raw.firstSeenRev;
      const firstSeenRev = existing ? existing.first_seen_rev : (raw.firstSeenRev ?? observedInRev);
      const lastSeenRev = rev ?? raw.lastSeenRev ?? observedInRev;
      const evidence = { ...raw.evidence };
      if (!evidence.rev) evidence.rev = observedInRev;
      const edge = { ...raw, id, evidence, observedInRev, firstSeenRev, lastSeenRev };
      assertValidEdge(edge);
      upsert.run(
        id,
        edge.src,
        edge.dst,
        edge.kind,
        edge.nature,
        edge.extractor,
        edge.extractorVersion,
        JSON.stringify(evidence),
        edge.observedInRev,
        edge.firstSeenRev,
        edge.lastSeenRev,
        edge.ruleId ?? null,
        edge.metadata !== undefined ? JSON.stringify(edge.metadata) : null,
      );
      count += 1;
    }
    return count;
  }

  /** Remove a node and every edge that referenced it. Returns the removed node. */
  removeNode(id) {
    const node = this.getNode(id);
    if (!node) return null;
    this._db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(id, id);
    this._db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return node;
  }

  /**
   * Remove a single node WITHOUT cascading to the edges that referenced it.
   *
   * The incremental engine reconciles edges by their own evidence location, so
   * a dangling reference (an `imports` edge to a deleted file, which a fresh
   * rebuild keeps because the import statement still exists) must survive the
   * node removal. `removeNode` would delete it; this precise variant does not.
   */
  removeNodeOnly(id) {
    const node = this.getNode(id);
    if (!node) return null;
    this._db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return node;
  }

  /** Remove a single edge. Returns the removed edge. */
  removeEdge(id) {
    const edge = this.getEdge(id);
    if (!edge) return null;
    this._db.prepare("DELETE FROM edges WHERE id = ?").run(id);
    return edge;
  }

  /** Drop every graph entity and revision. */
  clear() {
    this._db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM revisions;");
  }

  // -------------------------------------------------------------- revisions

  recordRevision(rev) {
    if (!rev || typeof rev.sha !== "string" || rev.sha.length === 0) return null;
    this._db
      .prepare(
        `INSERT INTO revisions (sha, parent, at, summary) VALUES (?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           parent = excluded.parent,
           at = excluded.at,
           summary = excluded.summary`,
      )
      .run(rev.sha, rev.parent ?? null, rev.at ?? null, rev.summary ?? null);
    return rev;
  }

  revisions() {
    return this._db
      .prepare("SELECT sha, parent, at, summary FROM revisions ORDER BY rowid")
      .all()
      .map((r) => {
        const rev = { sha: r.sha };
        if (r.parent !== null) rev.parent = r.parent;
        if (r.at !== null) rev.at = r.at;
        if (r.summary !== null) rev.summary = r.summary;
        return rev;
      });
  }

  /** The most recently recorded revision (by insertion order). */
  lastRevision() {
    const row = this._db.prepare("SELECT sha FROM revisions ORDER BY rowid DESC LIMIT 1").get();
    return row ? row.sha : null;
  }

  // ---------------------------------------------------------------- queries

  getNode(id) {
    const row = this._db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowToNode(row) : null;
  }

  getEdge(id) {
    const row = this._db.prepare("SELECT * FROM edges WHERE id = ?").get(id);
    return row ? rowToEdge(row) : null;
  }

  /** Nodes matching the filter; empty filter returns every node, ordered by id. */
  findNodes(filter = {}) {
    const where = [];
    const params = [];
    for (const [key, col] of Object.entries(NODE_FILTER_COLUMNS)) {
      if (filter[key] !== undefined) {
        where.push(`${col} = ?`);
        params.push(filter[key]);
      }
    }
    const sql =
      `SELECT * FROM nodes` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY id`;
    return this._db.prepare(sql).all(...params).map(rowToNode);
  }

  /** Edges matching the filter; empty filter returns every edge, ordered by id. */
  getEdges(filter = {}) {
    const where = [];
    const params = [];
    for (const [key, col] of Object.entries(EDGE_FILTER_COLUMNS)) {
      if (filter[key] !== undefined) {
        where.push(`${col} = ?`);
        params.push(filter[key]);
      }
    }
    const sql =
      `SELECT * FROM edges` +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY id`;
    return this._db.prepare(sql).all(...params).map(rowToEdge);
  }

  /** The evidence of a single edge: rule 1 makes it mandatory, so it is always present. */
  getEvidence(edgeId) {
    const row = this._db.prepare("SELECT evidence FROM edges WHERE id = ?").get(edgeId);
    return row ? JSON.parse(row.evidence) : null;
  }

  /** Canonical SHA-256 of the whole graph, independent of insertion order. */
  canonicalHash() {
    return graphCanonicalHash({ nodes: this.findNodes({}), edges: this.getEdges({}) });
  }
}