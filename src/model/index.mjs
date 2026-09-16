// The canonical model: schema, node/edge builders, validation and
// deterministic serialization. This is the vocabulary the rest of the product
// (store, analyzers, resolve, incremental, query) is written against.
export * from "./types.mjs";
export * from "./validate.mjs";
export * from "./serialize.mjs";
export { Graph } from "./graph.mjs";