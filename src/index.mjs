// IAGraphCreation public surface (slice 1: the canonical graph core, slice 2:
// the SQLite-backed store and Workspace scaffold).
//
// docs/API.md is the frozen contract the acceptance suite binds to. Subsequent
// slices grow this entry point: analyzers, resolve, incremental, query, viewer,
// copilot and cli. Until then only the implemented surface is exported, so
// importing this module never fabricates a capability that does not exist yet.
export * as model from "./model/index.mjs";
export * as scanner from "./scanner/index.mjs";

// Foundation-level conveniences mirror the names the acceptance uses, kept to a
// minimum on purpose: they must not outrun the store slice.
export { canonicalHash, graphCanonicalHash, canonicalString } from "./model/index.mjs";
export { scanRepository, listSourceFiles, resolveRevision } from "./scanner/index.mjs";

// Store slice (spine step 2): createWorkspace returns the Workspace scaffold
// with its SQLite-backed GraphStore and the minimal file-level ingest build.
export { createWorkspace, Workspace, GraphStore } from "./store/index.mjs";