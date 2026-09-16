// impact(workspace, target) -> { nodes, edges, reason } (docs/API.md).
//
// Delimita el área afectada por un cambio y dice la razón. `target` acepta:
//   { file: "api/Orders.cs" }            símbolos declarados en el archivo (D4)
//   { kind, withoutConsumers: true }     nodos sin consumidor (aceptación C5)
//   { nodeId }  o  string                un nodo y sus edges incidentes
//   { kind }                             todos los nodos de un kind
//
// Sólo devuelve nodos presentes en el store; ningún resultado se fabrica.

function impactOnFile(store, file) {
  const nodes = store.findNodes({ file });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = store.getEdges({}).filter((e) => ids.has(e.src) && ids.has(e.dst));
  return {
    nodes,
    edges,
    reason: `cambio en ${file}: ${nodes.length} nodos y ${edges.length} edges afectados`,
  };
}

function impactOnNode(store, node) {
  const edges = store.getEdges({ src: node.id }).concat(store.getEdges({ dst: node.id }));
  return {
    nodes: [node],
    edges,
    reason: `cambio en ${node.qualifiedName}: ${edges.length} edges incidentes`,
  };
}

function impactOrphans(store, target) {
  const kind = target.kind ?? "endpoint";
  const consumerKind = target.consumerKind ?? "calls_endpoint";
  const candidates = store.findNodes({ kind });
  const consumers = new Set(store.getEdges({ kind: consumerKind }).map((e) => e.dst));
  const orphans = candidates.filter((n) => !consumers.has(n.id));
  return {
    nodes: orphans,
    edges: [],
    reason: `${orphans.length} ${kind}(s) sin consumidor`,
  };
}

function impactOnKind(store, kind) {
  const nodes = store.findNodes({ kind });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = store.getEdges({}).filter((e) => ids.has(e.src) || ids.has(e.dst));
  return {
    nodes,
    edges,
    reason: `${kind}: ${nodes.length} nodos en el store`,
  };
}

/**
 * @param {object} workspace
 * @param {object|string} target
 * @returns {Promise<{ nodes: object[], edges: object[], reason: string }>}
 */
export async function impact(workspace, target) {
  const store = workspace.store;

  if (typeof target === "string") {
    const node = store.getNode(target);
    if (node) return impactOnNode(store, node);
    return impactOnFile(store, target);
  }

  if (target && typeof target === "object") {
    if (target.withoutConsumers) return impactOrphans(store, target);
    if (typeof target.file === "string") return impactOnFile(store, target.file);
    if (typeof target.nodeId === "string") {
      const node = store.getNode(target.nodeId);
      if (node) return impactOnNode(store, node);
      return { nodes: [], edges: [], reason: `nodo no encontrado: ${target.nodeId}` };
    }
    if (typeof target.kind === "string") return impactOnKind(store, target.kind);
  }

  return { nodes: [], edges: [], reason: "impact: objetivo desconocido" };
}