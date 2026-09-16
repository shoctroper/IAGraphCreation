// Deterministic serialization and canonical hashing (docs/API.md rule 7).
//
// The canonical hash is what proves that an incremental update is equivalent to
// a full rebuild (acceptance F1/F3). It must therefore depend only on semantic
// content: never on insertion order, key order, or operational metadata such as
// timestamps and durations.
//
// It must also never depend on where the source lives on disk (acceptance A7):
// the same revision checked out to two different absolute paths produces the
// same hash. Paths are serialised relative to the repository root before
// hashing, so the checkout location cannot leak into the canonical form.
import { createHash } from "node:crypto";
import { makeNodeId, makeEdgeId } from "./types.mjs";

/**
 * The canonical marker that stands for "the repository root itself". Paths are
 * serialised relative to this root before hashing (case A7): the root relative
 * to itself is `.`, and every path under a root is emitted as its relative
 * remainder. Byte-identical across machines and checkouts.
 */
const REPO_ROOT_MARKER = ".";

/**
 * Operational metadata: recorded for humans and health checks, but forbidden
 * from the canonical hash. Timestamps and durations are the obvious members
 * (`at` is the commit timestamp on a Revision); the whole `metadata` bag is
 * operational by construction.
 */
export const OPERATIONAL_KEYS = Object.freeze(
  new Set([
    "metadata",
    "createdAt",
    "updatedAt",
    "builtAt",
    "generatedAt",
    "startedAt",
    "finishedAt",
    "at",
    "durationMs",
    "elapsedMs",
    "duration",
    // Revision stamps are operational, not semantic (rule 5/7): the SAME graph
    // built incrementally keeps `firstSeenRev` history while a fresh rebuild
    // stamps everything at the current revision. F1/F3/F4/F5 prove
    // `incremental ≡ rebuild` through the canonical hash, so the hash must
    // depend on semantic content only — never on when a node was first seen or
    // which revision stamped it.
    "firstSeenRev",
    "lastSeenRev",
    "observedInRev",
    "rev",
  ]),
);

function compareCanonical(a, b) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * Reduce a value to its canonical shape:
 *   - objects drop operational keys and `undefined`, keys sorted;
 *   - arrays are sorted by canonical value, so insertion order cannot matter;
 *   - primitives pass through unchanged.
 */
export function canonicalForm(value) {
  if (Array.isArray(value)) {
    // `undefined` carries no information and is dropped from objects, so it is
    // dropped from arrays too: a sparse slot must not become `null` and flip a
    // hash between two otherwise identical builds.
    return value
      .map(canonicalForm)
      .filter((v) => v !== undefined)
      .sort(compareCanonical);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (OPERATIONAL_KEYS.has(key)) continue;
      const child = value[key];
      if (child === undefined) continue;
      out[key] = canonicalForm(child);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: stable under key order and array order. */
export function canonicalString(value) {
  return JSON.stringify(canonicalForm(value));
}

/** SHA-256 (hex) of the canonical form. */
export function canonicalHash(value) {
  return createHash("sha256").update(canonicalString(value)).digest("hex");
}

/** Stable ordering helpers: ids are deterministic, so they are the sort key. */
export function sortNodes(nodes) {
  return [...nodes].sort((a, b) => compareCanonical(a.id, b.id));
}

export function sortEdges(edges) {
  return [...edges].sort((a, b) => compareCanonical(a.id, b.id));
}

/**
 * Relativise a path against the repository roots present in the graph. The root
 * itself becomes `.` and everything under it is emitted as its relative
 * remainder, so the canonical form cannot leak the checkout location (A7).
 * Non-path values and paths outside every root pass through untouched.
 */
function relativizePath(value, roots) {
  if (typeof value !== "string") return value;
  for (const root of roots) {
    if (root && value === root) return REPO_ROOT_MARKER;
    if (root && value.startsWith(`${root}/`)) return value.slice(root.length + 1);
  }
  return value;
}

/**
 * Reduce a graph to its path-independent canonical form.
 *
 * The repository node carries the absolute checkout path as its identity
 * (`id`, `name`, `qualifiedName`); every other node/edge path is already
 * relative to that root. Before canonicalizing, the root(s) are lifted from the
 * repository nodes and every path — including the repository node itself and
 * the edges that reference it — is serialised relative to the root, so two
 * checkouts of the same revision at different locations hash identically.
 */
function relativizeGraph({ nodes = [], edges = [] } = {}) {
  const roots = [];
  const repoIds = new Map();
  for (const node of nodes) {
    if (node && node.kind === "repository") {
      if (typeof node.qualifiedName === "string" && node.qualifiedName.length > 0) {
        roots.push(node.qualifiedName);
      }
      repoIds.set(node.id, makeNodeId("repository", REPO_ROOT_MARKER));
    }
  }

  const relativize = (value) => relativizePath(value, roots);
  const relativizeEvidence = (evidence) =>
    Array.isArray(evidence) ? evidence.map((e) => ({ ...e, file: relativize(e.file) })) : evidence;

  const relativizedNodes = nodes.map((node) => {
    if (node && node.kind === "repository") {
      return {
        ...node,
        id: repoIds.get(node.id),
        name: REPO_ROOT_MARKER,
        qualifiedName: REPO_ROOT_MARKER,
        file: relativize(node.file),
        evidence: relativizeEvidence(node.evidence),
      };
    }
    return {
      ...node,
      file: relativize(node.file),
      qualifiedName: relativize(node.qualifiedName),
      evidence: relativizeEvidence(node.evidence),
    };
  });

  const relativizedEdges = edges.map((edge) => {
    const src = repoIds.get(edge.src) ?? edge.src;
    const dst = repoIds.get(edge.dst) ?? edge.dst;
    const evidence = edge.evidence
      ? { ...edge.evidence, file: relativize(edge.evidence.file) }
      : edge.evidence;
    const touched = src !== edge.src || dst !== edge.dst || evidence.file !== edge.evidence?.file;
    const id = touched
      ? makeEdgeId({ src, dst, kind: edge.kind, evidence, ruleId: edge.ruleId })
      : edge.id;
    return { ...edge, id, src, dst, evidence };
  });

  return { nodes: relativizedNodes, edges: relativizedEdges };
}

/**
 * The canonical graph form used for the whole-graph hash. Nodes and edges are
 * ordered by id, stripped of operational metadata, and every path is serialised
 * relative to the repository root so the hash is independent of the checkout
 * location (case A7).
 */
export function graphCanonicalForm({ nodes = [], edges = [] } = {}) {
  const { nodes: relNodes, edges: relEdges } = relativizeGraph({ nodes, edges });
  return {
    edges: sortEdges(relEdges).map(canonicalForm),
    nodes: sortNodes(relNodes).map(canonicalForm),
  };
}

/** SHA-256 (hex) of the canonical graph, independent of insertion order. */
export function graphCanonicalHash(graph) {
  return canonicalHash(graphCanonicalForm(graph));
}

/**
 * Stable JSON of a whole graph: nodes and edges ordered by id, operational
 * metadata stripped. Two builds of the same revision produce byte-identical
 * output regardless of insertion order or key order (docs/API.md rule 7).
 */
export function graphCanonicalString(graph) {
  return JSON.stringify(graphCanonicalForm(graph));
}
