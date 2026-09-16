// Resolve slice (spine step 4, docs/API.md `src/resolve`): derives rules and
// inferred edges from the observations surfaced by the analyzers. Every
// derived artifact stays evidence-bearing; nothing is marked EXTRACTED that is
// not read literally (rule 3) and nothing uncertain is invented (rule 2).
export { RESOLVER, RESOLVER_VERSION, resolveBindingRules } from "./binding-rule.mjs";