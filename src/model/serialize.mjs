// Deterministic serialization and canonical hashing (docs/API.md rule 7).
//
// The canonical hash is what proves that an incremental update is equivalent to
// a full rebuild (acceptance F1/F3). It must therefore depend only on semantic
// content: never on insertion order, key order, or operational metadata such as
// timestamps and durations.
import { createHash } from "node:crypto";

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
 * The canonical graph form used for the whole-graph hash. Nodes and edges are
 * ordered by id and stripped of operational metadata.
 */
export function graphCanonicalForm({ nodes = [], edges = [] } = {}) {
  return {
    edges: sortEdges(edges).map(canonicalForm),
    nodes: sortNodes(nodes).map(canonicalForm),
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
