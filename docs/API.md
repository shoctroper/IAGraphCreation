# Superficie pública de IAGraphCreation

Este documento es el contrato al que se atan los casos de aceptación. Cambiarlo
es cambiar la aceptación, y eso sólo ocurre con la ventana cerrada.

Diseño de referencia: `MarioGovernance/docs/milestones/G1-IAGRAPH/RFC-G1.md` (v3, ratificado).

## Módulos

```
src/model/        esquema canónico: Node, Edge, Evidence, Revision, BindingRule
src/store/        GraphStore sobre SQLite (node:sqlite), la fuente de verdad
src/analyzers/    por lenguaje: csharp, typescript. Producen hechos, no edges finales
src/resolve/      tabla de símbolos, resolución cross-file, bindings y reglas
src/incremental/  diff de git -> región afectada -> reanálisis -> upsert
src/query/        search, explain, path, impact
src/viewer/       compilador a un HTML autocontenido
src/copilot/      instrucciones por ruta y servidor MCP
src/cli/          iagraph
```

## Reglas invariantes

Estas reglas mandan sobre cualquier detalle de implementación. Un caso de
aceptación que las contradiga es un error del caso, no del código.

1. **Ningún edge sin evidencia.** Todo edge lleva `file` y `lineStart`. Un edge
   sin evidencia es un defecto, no un edge de baja confianza.
2. **Ante la duda, no hay edge.** Es preferible un hueco honesto a un enlace
   inventado. Un enlace falso envenena a Copilot.
3. **`EXTRACTED` sólo si se lee literalmente en el código.** Todo lo demás es
   `INFERRED` o `AMBIGUOUS`.
4. **Una sola fuente de verdad.** El contexto para IA y el visor se derivan del
   mismo SQLite. Está prohibido que existan dos grafos que puedan divergir.
5. **El grafo conoce la revisión.** Nodos y edges llevan `firstSeenRev` y
   `lastSeenRev`; los edges llevan además `observedInRev`.
6. **Los nodos se identifican por nombre cualificado, no por archivo.** Es lo que
   permite que una `partial class` repartida en varios archivos sea un solo nodo.
7. **Metadata operacional separada del contenido semántico.** Las marcas de
   tiempo y duraciones no entran en el hash canónico.

## API

### `createWorkspace(dir, options) -> Workspace`
Crea o abre un workspace. `options.storePath` por defecto `<dir>/.iagraph/graph.db`.

### `Workspace`
```
addRepo({ path, role })        role: 'api' | 'ui' | 'lib'
build({ rev? })                construcción completa -> BuildReport
update({ from?, to? })         incremental dirigido por git -> UpdateReport
rebuild()                      reconstrucción total desde source
verify()                       comprueba incremental ≡ rebuild -> VerifyReport
status()                       revisiones, deriva, salud -> StatusReport
canonicalHash()                SHA256 del grafo canónico, sin metadata operacional
store                          GraphStore
```

### `GraphStore`
```
getNode(id) / findNodes(filter)
getEdges({ src?, dst?, kind?, nature? })
getEvidence(edgeId)
upsertNodes(nodes, rev) / upsertEdges(edges, rev)
revisions()
```

### Consulta
```
search(workspace, query, opts)   -> [{ node, score, evidence }]
explain(workspace, nodeId)       -> { node, incoming, outgoing, evidence, revision }
path(workspace, fromId, toId)    -> { found, hops: [{ edge, evidence }] }
impact(workspace, target)        -> { nodes, edges, reason }
```
Toda respuesta de consulta es rastreable hasta evidencia en el source. Una
consulta no inventa nodos ni edges.

### Visor
```
renderViewer(workspace, { focus?, out }) -> ruta del HTML
```
Un solo archivo, sin red en runtime, abrible desde `file://`. Debe soportar
SEARCH, FILTER, FOCUS, EXPAND, COLLAPSE, UPSTREAM, DOWNSTREAM, DETAILS.

### Copilot
```
generateCopilotContext(workspace, { out }) -> [rutas escritas]
startMcpServer(workspace, opts)            -> { close() }
```

### CLI
```
iagraph init | add-repo | build | update | rebuild | verify | status
iagraph search | explain | path | impact
iagraph view | mcp | copilot-context
```

## Tipos del modelo

```ts
type Nature = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

type NodeKind =
  | 'repository' | 'project' | 'module' | 'namespace' | 'file'
  | 'type' | 'class' | 'interface' | 'method' | 'function'
  | 'endpoint' | 'route' | 'client' | 'component' | 'page'
  | 'binding' | 'binding_rule';

type EdgeKind =
  | 'contains' | 'imports' | 'calls' | 'references'
  | 'inherits' | 'implements' | 'instantiates'
  | 'declares_endpoint' | 'calls_endpoint' | 'consumed_by' | 'routes_to'
  | 'binds_implementation' | 'generated_from';

interface Evidence { file: string; lineStart: number; lineEnd?: number; rev: string; }

interface Edge {
  id: string; src: string; dst: string;
  kind: EdgeKind; nature: Nature;
  extractor: string; extractorVersion: string;
  evidence: Evidence;
  observedInRev: string; firstSeenRev: string; lastSeenRev: string;
  ruleId?: string;   // presente cuando el edge lo produjo una binding_rule
}
```

### `binding_rule` — por qué existe

Un registro por escaneo de ensamblado (`RegisterServicesFromAssembly`,
`AddValidatorsFromAssembly`, `AddMaps(Assembly…)`) **no es un hecho con una
ubicación: es una regla con un dominio.** Si se tratara como un hecho anclado a
su archivo, añadir un handler nuevo no invalidaría nada —porque el archivo que
declara el escaneo no cambia— y el handler desaparecería del grafo en silencio.

Por eso una `binding_rule` lleva `scope` (el proyecto o ensamblado) y su
**dominio de invalidación es ese scope entero**: cualquier alta, baja o
renombrado dentro del scope la reevalúa. Los edges que deriva nacen `INFERRED`
y llevan `ruleId`, para que quien lea el grafo sepa que ese enlace lo puso un
escaneo y no una línea de código.
