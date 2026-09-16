// In-memory canonical graph: the revision-aware container the store (slice 2)
// will persist. It validates every mutation against the model invariants and
// exposes the canonical hash that proves incremental ≡ rebuild.
import { assertValidNode, assertValidEdge } from "./validate.mjs";
import { withRevision } from "./types.mjs";
import { graphCanonicalHash } from "./serialize.mjs";

export class Graph {
  constructor({ rev } = {}) {
    this._rev = rev ?? null;
    this._nodes = new Map();
    this._edges = new Map();
  }

  get rev() {
    return this._rev;
  }

  node(id) {
    return this._nodes.get(id);
  }

  edge(id) {
    return this._edges.get(id);
  }

  nodes() {
    return [...this._nodes.values()];
  }

  edges() {
    return [...this._edges.values()];
  }

  get nodeCount() {
    return this._nodes.size;
  }

  get edgeCount() {
    return this._edges.size;
  }

  /**
   * Insert or refresh a node at the current revision. A node that already
   * exists keeps its `firstSeenRev` and advances `lastSeenRev` (rule 5).
   */
  upsertNode(node, rev = node.lastSeenRev ?? node.firstSeenRev) {
    const existing = this._nodes.get(node.id);
    let next;
    if (existing) {
      next = {
        ...existing,
        ...node,
        firstSeenRev: existing.firstSeenRev,
        lastSeenRev: rev ?? existing.lastSeenRev,
      };
    } else {
      next = withRevision(node, rev);
    }
    assertValidNode(next);
    this._nodes.set(next.id, next);
    return next;
  }

  /** Insert or refresh an edge; evidence and nature are validated. */
  upsertEdge(edge, rev = edge.lastSeenRev ?? edge.observedInRev) {
    const existing = this._edges.get(edge.id);
    const next = existing
      ? {
          ...existing,
          ...edge,
          // Rule 5: re-observing an edge must never rewrite its birth.
          firstSeenRev: existing.firstSeenRev,
          lastSeenRev: rev ?? existing.lastSeenRev,
        }
      : { ...edge, lastSeenRev: rev ?? edge.lastSeenRev };
    assertValidEdge(next);
    this._edges.set(next.id, next);
    return next;
  }

  /** Remove a node and every edge that referenced it, returning the removed. */
  removeNode(id) {
    const node = this._nodes.get(id);
    if (!node) return null;
    this._nodes.delete(id);
    for (const [eid, edge] of this._edges) {
      if (edge.src === id || edge.dst === id) this._edges.delete(eid);
    }
    return node;
  }

  removeEdge(id) {
    const edge = this._edges.get(id);
    if (!edge) return null;
    this._edges.delete(id);
    return edge;
  }

  /** Canonical SHA-256 of the whole graph, independent of insertion order. */
  canonicalHash() {
    return graphCanonicalHash({ nodes: this.nodes(), edges: this.edges() });
  }
}