// path(workspace, fromId, toId) -> { found, hops: [{ edge, evidence }] }
// (docs/API.md). BFS sobre el grafo de navegación (stored edges + contención
// derivada de la evidencia de los nodos). Cada salto cita su evidencia con
// `file` y `lineStart > 0`: un camino no fabrica nodos ni enlaces — los nodos
// recorridos existen en el store y la evidencia de cada salto se lee del store.

import { buildAdjacency } from "./navigation.mjs";

/**
 * @param {object} workspace
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<{ found: boolean, hops: Array<{ edge: object, evidence: object }> }>}
 */
export async function path(workspace, fromId, toId) {
  const store = workspace.store;
  if (!store.getNode(fromId) || !store.getNode(toId)) {
    return { found: false, hops: [] };
  }
  if (fromId === toId) return { found: true, hops: [] };

  const adj = buildAdjacency(store);
  const prev = new Map();
  const seen = new Set([fromId]);
  const queue = [fromId];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const step of adj.get(current) ?? []) {
      if (seen.has(step.node)) continue;
      seen.add(step.node);
      prev.set(step.node, { from: current, edge: step.edge, evidence: step.evidence });
      if (step.node === toId) {
        const hops = [];
        let cursor = toId;
        while (cursor !== fromId) {
          const record = prev.get(cursor);
          hops.unshift({ edge: record.edge, evidence: record.evidence });
          cursor = record.from;
        }
        return { found: true, hops };
      }
      queue.push(step.node);
    }
  }

  return { found: false, hops: [] };
}