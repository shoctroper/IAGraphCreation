# IAGraphCreation

Un mapa canónico, trazable y actualizable del código de dos repositorios
relacionados (API + UI), convertido en contexto útil para GitHub Copilot y
presentado en un visor local interactivo.

**No requiere instalar Graphify, Archify ni ninguna otra herramienta de terceros
para funcionar.**

## Por qué existe

Navegar a ciegas un repositorio grande es caro, para una persona y para un
asistente. Este proyecto construye un grafo del código —tipos, métodos,
endpoints, llamadas, dependencias y, sobre todo, las relaciones entre la API y
la UI— con una regla que lo gobierna todo:

> **Ningún enlace sin evidencia, y ante la duda no hay enlace.**

Cada relación guarda el archivo, la línea y la revisión donde se observó, y
declara si se leyó literalmente en el código (`EXTRACTED`) o se dedujo
(`INFERRED`). Un grafo con huecos honestos es utilizable; uno con enlaces
inventados envenena a quien lo consulte.

## Estado

En construcción, bajo Goal gobernado por
[MarioGovernance](https://github.com/shoctroper/MarioGovernance).
El diseño está ratificado y los 62 casos de aceptación están fijados en
`tests/acceptance/` desde antes de escribir la primera línea de implementación.

```
npm test                  # suite del proyecto
npm run test:acceptance   # los 62 casos fijados
node tests/acceptance/evaluate.mjs   # progreso contra la aceptación
```

## Diseño

- Contrato público de la API: [`docs/API.md`](docs/API.md)
- RFC completo, con la investigación de Graphify y Archify y las dos rondas de
  ataque que lo corrigieron: `MarioGovernance/docs/milestones/G1-IAGRAPH/`

## Licencia

MIT. Las gramáticas de tree-sitter vienen vendorizadas como WASM para que el
producto se instale sin toolchain nativo; su procedencia y licencia están en
[`vendor/wasm/NOTICE.md`](vendor/wasm/NOTICE.md).
