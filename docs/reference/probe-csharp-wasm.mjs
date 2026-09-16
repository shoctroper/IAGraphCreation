// De-risking probe for RFC-G1 D2/D3: can web-tree-sitter (WASM, no native
// toolchain) extract from REAL C# the two things the design depends on?
//   1. endpoint declarations  -> MapGet/MapPost with their route literal
//   2. DI bindings            -> AddSingleton<IFace>(... GetRequiredService<Impl>())
// The second is the one the questioner called critical: if we cannot see the
// binding, the incremental update is blind to it.
import { Parser, Language, Query } from "web-tree-sitter";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
await Parser.init();
const lang = await Language.load(require.resolve("tree-sitter-c-sharp/tree-sitter-c_sharp.wasm"));
const parser = new Parser();
parser.setLanguage(lang);

const file = process.argv[2];
const src = readFileSync(file, "utf8");
const t0 = performance.now();
const tree = parser.parse(src);
const ms = performance.now() - t0;

const text = (n) => src.slice(n.startIndex, n.endIndex);
const line = (n) => n.startPosition.row + 1;

// tree-sitter queries: the same mechanism a real extractor would use.
const q = new Query(lang, `
  (invocation_expression
    function: (member_access_expression name: (identifier) @m)
    arguments: (argument_list) @args) @call
  (invocation_expression
    function: (member_access_expression
      name: (generic_name (identifier) @gname (type_argument_list) @targs))
    arguments: (argument_list) @gargs) @gcall
`);

const endpoints = [], bindings = [];
for (const m of q.matches(tree.rootNode)) {
  const cap = Object.fromEntries(m.captures.map((c) => [c.name, c.node]));
  if (cap.m && /^Map(Get|Post|Put|Delete|Patch)$/.test(text(cap.m))) {
    const route = text(cap.args).match(/"([^"]*)"/);
    endpoints.push({ method: text(cap.m).replace("Map", "").toUpperCase(),
                     route: route ? route[1] : null, line: line(cap.call) });
  }
  if (cap.gname && /^Add(Singleton|Scoped|Transient)$/.test(text(cap.gname))) {
    const iface = text(cap.targs).replace(/^<|>$/g, "");
    const impl = text(cap.gargs).match(/GetRequiredService<([^>]+)>/);
    bindings.push({ lifetime: text(cap.gname).replace("Add", ""), iface,
                    impl: impl ? impl[1] : null, line: line(cap.gcall) });
  }
}

console.log(`archivo: ${file}`);
console.log(`bytes: ${src.length}  parse: ${ms.toFixed(1)} ms  errores de sintaxis: ${tree.rootNode.hasError}`);
console.log(`\nENDPOINTS (${endpoints.length}):`);
for (const e of endpoints.slice(0, 8)) console.log(`  L${e.line}  ${e.method.padEnd(6)} ${e.route ?? "(sin literal)"}`);
console.log(`\nBINDINGS DI (${bindings.length}):`);
for (const b of bindings) console.log(`  L${b.line}  ${b.iface} -> ${b.impl ?? "(factory opaca)"}  [${b.lifetime}]`);
