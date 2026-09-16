# MEASUREMENTS — spike medido del RFC-G1 §8 (Attempt 0)

> **Propósito.** Línea de base pre-implementación que manda el RFC-G1 §8 antes de
> intentar cualquier módulo del spine. Registra los números del spike medido sobre
> C1 —`/Volumes/Medios/Repos/AthenaFramework`— con herramientas reales y sin build
> nativo, y el veredicto contra el umbral que el RFC fijó por adelantado.
>
> **Fecha:** 2026-09-16 · **Entorno:** macOS (darwin), Node `v22.23.1`,
> `web-tree-sitter@0.27.0` (WASM), gramática C# vendorizada
> (`vendor/wasm/tree-sitter-c_sharp.wasm`, 5,1 MB), `node:sqlite` (WAL).
> **Corpus:** `AthenaFramework` completo, sin `obj/`, `bin/`, `node_modules/`, `.git/`.
>
> **Procedencia.** Medido por el ejecutor en el Attempt 0 del Goal `g1-iagraph`, y
> **corroborado por el Arquitecto con un script independiente** (§11). Se restauró
> tras una reversión operativa, con el contenido de la medición original intacto.

---

## 1. Método

Todo el spike corre con `web-tree-sitter` en WASM (nada de `node-gyp`, nada de
compilar gramáticas) sobre **los 1.578 archivos `.cs` de C1**, con un único
`Parser` reutilizado (estado térmico) y cuatro familias de queries tree-sitter:

1. **parseo**: `parser.parse(src)` por archivo, cronometrado por archivo.
2. **símbolos**: declaraciones de `class/interface/record/struct/enum/namespace`
   y `method_declaration`.
3. **referencias**: identificadores en posición de tipo (`object_creation`,
   `variable_declaration`, `parameter`, `base_list`, receptor de
   `member_access_expression`).
4. **endpoints y bindings**: `MapGet/MapPost/MapPut/MapDelete/MapPatch` y
   `AddSingleton/AddScoped/AddTransient`.

La **costura global** se mide como lo que es: un índice plano `nombre → símbolo`
en memoria y una consulta por referencia —**sin reparsear nada**—, midiendo el
tiempo de construir el índice y de resolver las 44.057 referencias.

El **grafo en SQLite** se escribe con `node:sqlite` en modo WAL: nodos
(`file` + `type`), edges `contains` con `nature`, y su `evidence`; luego
`wal_checkpoint(TRUNCATE)` para medir el tamaño asentado en disco.

El **update de un archivo** se mide como: reparsear el archivo mediano + volver a
resolver sólo las referencias que apuntan a los símbolos de ese archivo. El
`rebuild` es el pase completo.

---

## 2. Corpus C1

| Métrica | Valor |
|---|---|
| Archivos `.cs` | **1.578** |
| Bytes en disco | 6.792.850 B (~6,48 MiB) |
| Proyectos en `src/` (`*.csproj`) | **13** |
| Archivos con nodo `ERROR` en el AST | **0** |
| Archivo más grande | 108.004 B |
| Mediana (`p50`) por archivo | 1.751 B |
| `p90` / `p95` / `p99` | 10.136 B / 14.324 B / 30.836 B |

---

## 3. Parseo (¿aguanta WASM la escala real?)

| Métrica | Valor |
|---|---|
| **Parseo puro, total del repo** | **~910 ms** (908–920 en 4 corridas) |
| Pase completo parseo + extracción | ~1.480 ms |
| Rendimiento | **~1.736 archivos/s · ~7,1 MB/s** |
| p50 / p90 / p95 / p99 por archivo | 0,16 / 1,66 / 2,25 / 3,66 ms |
| **Máximo** | **12,7 ms** (`Athena.Core/EditorialCaseOrchestrator.cs`, 108 KB) |

### Continuidad con la sonda del RFC §4 D2

| Archivo | Frío | Térmico |
|---|---|---|
| `Athena.Operator/Program.cs` (20.686 B) | **11,98 ms** | **4,04 ms** |

El RFC cita **11,2 ms** para ese archivo: el frío mide 11,98 ms. No hay
discrepancia, hay dos estados de temperatura distintos y aquí se separan.

**Veredicto:** WASM aguanta C1 con holgura. Repo entero en ~1 s.

---

## 4. Escala de extracción

| Símbolo | Conteo |
|---|---|
| Declaraciones de tipo | **3.623** |
| Métodos | **5.761** |
| Referencias en posición de tipo | **44.057** |
| Endpoints `Map*` | **28**, todos en `Athena.Operator/Program.cs` |
| Registros DI | **249** |

---

## 5. Coste de la costura global

| Métrica | Valor |
|---|---|
| **Costura global, corpus entero** | **4,1 ms** (4,1–4,3 en 4 corridas) |
| Referencias resueltas | 44.057 |
| Aciertan contra un símbolo del repo | 17.157 (39 %) |
| No aciertan (tipos de framework) | 26.900 (61 %) |

Dos lecturas, ambas honestas:

1. **El coste es ínfimo: 0,45 % del parseo.** La «costura global barata» de D6
   **no es un linker encubierto** a esta escala: el pase completo cuesta menos
   que parsear un solo archivo mediano-grande.
2. **El 61 % de fallos es el hueco esperado, no un defecto.** El spike usa un
   índice plano por nombre corto, sin `using` ni nombre cualificado. El
   resolutor final de D6 resolverá por nombre cualificado + contexto. **Este
   spike demuestra el coste, no la precisión**; la precisión se mide contra el
   oráculo (§6·B y §6·C de la aceptación).

---

## 6. Tamaño del grafo y de los artefactos (D10)

| Métrica | Valor |
|---|---|
| Nodos escritos | 5.201 |
| Edges + evidencia | 3.623 + 3.623 |
| Escritura (transacción WAL) | ~420–460 ms |
| **SQLite en disco (checkpointed)** | **2,88 MiB** (~1,9 KB/archivo) |
| **JSON canónico derivado** | **1,13 MiB**, serializado en ~2 ms |

El tope de 512 MiB que limita a Graphify no aparece ni de lejos. Una partición
por repositorio o por proyecto cabe cómodamente, y el visor autocontenido puede
incrustar el JSON sin romper el requisito de abrir desde `file://`.

---

## 7. Build completo vs update de un archivo — el umbral del 20 %

| Métrica | Valor |
|---|---|
| `rebuild` (pase completo) | ~1.480 ms |
| `git diff --name-status -M` (commit real, 15 entradas) | 19,8 ms |
| **`update` de un archivo** (reparse 0,28 ms + re-resolver 1,34 ms) | **~1,70 ms** |
| **Ratio `update / rebuild`** | **0,12 %** |
| Umbral declarado (20 % de `rebuild`) | ≈ 295 ms |

> *«Si el `update` de un cambio local supera el 20 % del tiempo del `rebuild`, el
> diseño de invalidación se considera fallido y se rediseña antes de seguir.»*
> — RFC-G1 §8, fijado antes de medir.

**El `update` es el 0,12 % del `rebuild`, casi tres órdenes de magnitud por
debajo del umbral. El rediseño condicionado NO se dispara.**

---

## 8. Extrapolación a la escala de `lubesoft`

**Etiquetada como extrapolación, no medición.** Factor lineal `9454/1578 = ×5,99`.

| Métrica | C1 (medido) | `lubesoft` (extrapolado) |
|---|---|---|
| Parseo puro | ~0,91 s | ~5,45 s |
| Pase completo | ~1,48 s | ~8,83 s |
| Costura global | 4,1 ms | ~24,6 ms |
| SQLite | 2,88 MiB | ~17,2 MiB |
| JSON canónico | 1,13 MiB | ~6,8 MiB |

Ni a 9.454 archivos aparece un problema de escala en parseo, costura o almacén.
El punto de tensión real sigue siendo el declarado en R-5: **el visor** dibujando
miles de nodos, que este spike no resuelve.

---

## 9. Lo que este spike NO probó

1. **Cambios transversales (R-4).** Se midió el cambio local, que es el caso que
   el RFC nombra. El peor caso está acotado por la costura completa (4,1 ms),
   pero no se midió hoy; se medirá en el spike de `src/resolve`.
2. **Precisión.** §4 y §5 miden escala y coste, no precisión de resolución.
3. **Portabilidad (§6·K).** Estos números son de este Mac. La portabilidad se
   prueba en el contenedor `node:22-alpine`, no aquí.
4. **`obj/` y `bin/`** excluidos siempre (R-9).

---

## 10. Decisiones que estos números habilitan

- **D2 (WASM):** la escala real no es problema. Se mantiene.
- **D6 (incremental):** viable. Umbral del 20 % no alcanzado.
- **D10 (partición):** 1,13 MiB para C1; partición cómoda.
- **D4 (SQLite):** 2,88 MiB asentado; escritura ~0,4 s para el repo entero.

---

## 11. Auditoría independiente del Arquitecto

Los agentes se equivocan y en este ciclo ya hubo informes con afirmaciones
falsas, así que las cifras que sostienen una decisión se contrastan con código
propio, no con el del ejecutor.

| Métrica | Ejecutor | Auditoría independiente | |
|---|---|---|---|
| Archivos `.cs` | 1.578 | **1.578** | exacto |
| Bytes | 6.792.850 | **6.792.850** | exacto |
| Parseo total | ~910 ms | **939,2 ms** | dentro del ruido |
| Archivos/s | ~1.736 | **1.680** | consistente |
| Errores de sintaxis | 0 | **0** | exacto |
| Endpoints `Map*` | 28 | **28** | exacto, y coincide con la sonda del RFC |
| Registros DI | 249 | 266 (conteo textual) | métodos distintos, no decisorio |

**Veredicto de la auditoría: las mediciones son honestas y reproducibles.** La
única diferencia es el conteo de registros DI, donde la auditoría contó
textualmente y el ejecutor por query de AST; no sostiene ninguna decisión.
