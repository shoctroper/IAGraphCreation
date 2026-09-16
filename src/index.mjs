// IAGraphCreation public surface (slice 1: the canonical graph core, slice 2:
// the SQLite-backed store and Workspace scaffold, slice 3: the C# analyzer).
//
// docs/API.md is the frozen contract the acceptance suite binds to. Subsequent
// slices grow this entry point: resolve, incremental, query, viewer, copilot
// and cli. Until then only the implemented surface is exported, so importing
// this module never fabricates a capability that does not exist yet.
export * as model from "./model/index.mjs";
export * as scanner from "./scanner/index.mjs";
export * as analyzers from "./analyzers/index.mjs";

// Foundation-level conveniences mirror the names the acceptance uses, kept to a
// minimum on purpose: they must not outrun the store slice.
export { canonicalHash, graphCanonicalHash, canonicalString } from "./model/index.mjs";
export { scanRepository, listSourceFiles, resolveRevision } from "./scanner/index.mjs";

// Store slice (spine step 2): createWorkspace returns the Workspace scaffold
// with its SQLite-backed GraphStore and the minimal file-level ingest build.
export { createWorkspace, Workspace, GraphStore } from "./store/index.mjs";

// Query slice (spine step 7): search, explain, path and impact, each returning
// evidence traceable to the store (docs/API.md "Consulta").
export { search, explain, path, impact } from "./query/index.mjs";

// Resolve slice (spine step 4): derives rules from the observations the
// analyzers surface. binding_rule nodes carry the scanned assembly/project as
// their scope and cite the literal scan call as evidence.
export * as resolve from "./resolve/index.mjs";
export { resolveBindingRules } from "./resolve/index.mjs";

// Incremental slice (spine step 6): the git-diff-driven engine that turns a
// commit into a precise mutation of the graph (affected region -> re-analysis
// -> store reconcile) and reports the computed invalidation scope.
export * as incremental from "./incremental/index.mjs";
export {
  gitDiff,
  updateRepository,
  computeRegion,
  buildTypeIndexFromStore,
  applyRegion,
} from "./incremental/index.mjs";

// Viewer slice (spine step 8): compiles the graph into ONE standalone HTML file
// with the data embedded as JSON, no network at runtime, openable from file://
// (docs/API.md "Visor"). It reads nodes and edges from the same store the AI
// context derives from (rule 4) and implements SEARCH, FILTER, FOCUS, EXPAND,
// COLLAPSE, UPSTREAM, DOWNSTREAM and DETAILS.
export { renderViewer } from "./viewer/index.mjs";