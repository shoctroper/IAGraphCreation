// Query slice (spine step 7, docs/API.md `src/query`): search, explain, path e
// impact. Toda respuesta es rastreable a evidencia del store; una consulta no
// inventa nodos ni edges (docs/API.md reglas 1-2).
export { search } from "./search.mjs";
export { explain } from "./explain.mjs";
export { path } from "./path.mjs";
export { impact } from "./impact.mjs";