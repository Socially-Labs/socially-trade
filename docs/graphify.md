# Project knowledge graph

Graphify indexes backend symbols, database migrations, architecture documentation,
the simulation report and the product whitepaper. Documentation describes both
implemented functionality and future plans; graph connections alone do not prove
that a feature is implemented. Confirm implementation details in the linked source.

## Install

Requires Python and `uv` (Graphify is development tooling, not an application dependency).

```sh
uv tool install --with tree-sitter-sql graphifyy==0.9.57
```

The SQL parser is required to index the PostgreSQL migrations.

## Explore

From the repository root:

```sh
graphify query "paper trading orders and crew performance"
graphify explain "submitOrder"
graphify god-nodes
```

- `graphify-out/graph.json`: portable graph data with relative source paths.
- `graphify-out/GRAPH_REPORT.md`: graph structure and extraction audit.
- `graphify-out/graph.html`: interactive graph; open this file in a browser.

## Refresh

```sh
graphify update .
graphify export html
```

`update` refreshes code through local AST extraction. For documentation or
whitepaper changes, ask an agent with the Graphify skill to run `/graphify . --update`
for semantic extraction too. A complete rebuild is `/graphify .`.
No API key is required for code extraction or agent-assisted semantic extraction.

Review and commit generated outputs after a refresh. There is no automatic Git
commit hook. The `AGENTS.md` instructions guide future Codex sessions.

## Scope and exclusions

`.graphifyignore` excludes dependencies, build output, environment files and the
unrelated résumé. Graphify also skips sensitive files such as `.npmrc`.
Local caches, manifests, extraction intermediates and interpreter paths are ignored
by Git. Only graph data, its report and the HTML visualization are shared.
Semantic token usage is unavailable from the agent interface and is reported as
unknown, rather than as zero-cost extraction.
