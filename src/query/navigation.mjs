// Query-side navigation graph (docs/API.md `src/query`, spine step 7).
//
// search/explain/path/impact answer structural questions over a navigation
// graph built from TWO sources, both fully grounded in the store:
//
//   1. the stored edges of the GraphStore, traversable in both directions, and
//   2. file containment derived from each node's own evidence: a symbol whose
//      evidence declares `file`/`lineStart` is adjacent to the file node that
//      contains it. The node and its evidence are stored facts, so the derived
//      relationship never invents a location; it is only marked `INFERRED` and
//      attributed to this extractor so it is never confused with an
//      analyzer-produced edge.
//
// Rule 1 of docs/API.md is enforced here: every hop carries `evidence.file`
// and a positive `evidence.lineStart`, whether the hop is a stored edge or a
// derived one. A file node that does not exist in the store never becomes a
// neighbour (no fabricated nodes).

import { makeNodeId } from "../model/index.mjs";

export const QUERY_EXTRACTOR = "query";
export const QUERY_EXTRACTOR_VERSION = "0.1.0";

function addNeighbour(adj, fromId, entry) {
  let list = adj.get(fromId);
  if (!list) {
    list = [];
    adj.set(fromId, list);
  }
  list.push(entry);
}

/**
 * Build the adjacency of the navigation graph.
 *
 * @returns {Map<string, Array<{ node: string, edge: object, evidence: object }>>}
 */
export function buildAdjacency(store) {
  const adj = new Map();

  // Source 1: stored edges, in both directions.
  for (const edge of store.getEdges({})) {
    addNeighbour(adj, edge.src, { node: edge.dst, edge, evidence: edge.evidence });
    addNeighbour(adj, edge.dst, { node: edge.src, edge, evidence: edge.evidence });
  }

  // Source 2: file containment read off each node's own evidence, only toward
  // file nodes that actually exist in the store.
  const fileIds = new Set(store.findNodes({ kind: "file" }).map((n) => n.id));
  for (const node of store.findNodes({})) {
    if (node.kind === "repository") continue;
    const evidence = (node.evidence ?? []).find(
      (e) => e && typeof e.file === "string" && Number.isInteger(e.lineStart),
    );
    if (!evidence) continue;
    const fileId = makeNodeId("file", evidence.file);
    if (!fileIds.has(fileId) || fileId === node.id) continue;

    const edge = {
      id: `${node.id}->${fileId}:contains`,
      src: node.id,
      dst: fileId,
      kind: "contains",
      nature: "INFERRED",
      extractor: QUERY_EXTRACTOR,
      extractorVersion: QUERY_EXTRACTOR_VERSION,
      evidence,
    };
    if (typeof evidence.rev === "string") {
      edge.observedInRev = evidence.rev;
      edge.firstSeenRev = evidence.rev;
      edge.lastSeenRev = evidence.rev;
    }
    addNeighbour(adj, node.id, { node: fileId, edge, evidence });
    addNeighbour(adj, fileId, { node: node.id, edge, evidence });
  }

  return adj;
}