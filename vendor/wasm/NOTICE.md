# Gramáticas vendorizadas

Se incluyen aquí los binarios WASM en lugar de depender de los paquetes npm de
gramática, porque esos paquetes traen `binding.gyp` y *prebuilds* nativos. El
producto debe instalarse en una máquina sin toolchain de C, así que el runtime
no depende de ellos.

| Archivo | Origen | Versión | Licencia |
|---|---|---|---|
| `web-tree-sitter.wasm` | [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | 0.27.0 | MIT |
| `tree-sitter-c_sharp.wasm` | [tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp) | 0.23.5 | MIT |
| `tree-sitter-typescript.wasm` | [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | 0.23.2 | MIT |
| `tree-sitter-tsx.wasm` | idem | 0.23.2 | MIT |

Todas MIT, compatibles con la licencia MIT de este proyecto.
