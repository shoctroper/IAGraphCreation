// search(workspace, query, opts) -> [{ node, score, evidence }] (docs/API.md).
//
// A consulta no inventa nodos: sólo devuelve nodos que ya viven en el store
// (regla de aceptación D5). La evidencia de cada resultado es la del propio
// nodo en el store, de modo que todo acierto es rastreable al source.

function scoreNode(node, q) {
  const name = (node.name ?? "").toLowerCase();
  const qualified = (node.qualifiedName ?? "").toLowerCase();
  const route = (node.route ?? "").toLowerCase();
  const file = (node.file ?? "").toLowerCase();

  if (name === q) return 1000;
  if (qualified === q) return 950;
  if (route === q) return 900;
  if (name.startsWith(q)) return 800;
  if (name.includes(q)) return 700;
  if (qualified.startsWith(q)) return 600;
  if (qualified.includes(q)) return 500;
  if (route.includes(q)) return 400;
  if (file.includes(q)) return 300;
  return 0;
}

/**
 * @param {object} workspace
 * @param {string} query   free-text, matched case-insensitively
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.kind] restrict the search to one node kind
 * @returns {Promise<Array<{ node: object, score: number, evidence: object|null }>>}
 */
export async function search(workspace, query, opts = {}) {
  const { limit = 25, kind } = opts ?? {};
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length === 0) return [];

  const hits = [];
  for (const node of workspace.store.findNodes({ kind })) {
    const score = scoreNode(node, q);
    if (score <= 0) continue;
    hits.push({ node, score, evidence: node.evidence?.[0] ?? null });
  }
  hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return hits.slice(0, limit);
}