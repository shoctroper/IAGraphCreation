// explain(workspace, nodeId) -> { node, incoming, outgoing, evidence, revision }
// (docs/API.md). La respuesta reporta la revisión vigente del store (regla 5):
// nunca una revisión de memoria. Los edges entrantes y salientes son los del
// store; la evidencia es la del propio nodo.

/**
 * @param {object} workspace
 * @param {string} nodeId
 * @returns {Promise<object|null>} null cuando el nodo no existe en el store
 */
export async function explain(workspace, nodeId) {
  const store = workspace.store;
  const node = store.getNode(nodeId);
  if (!node) return null;
  return {
    node,
    incoming: store.getEdges({ dst: nodeId }),
    outgoing: store.getEdges({ src: nodeId }),
    evidence: node.evidence ?? [],
    revision: store.lastRevision(),
  };
}