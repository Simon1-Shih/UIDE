# UIDE Pywebview Prototype

UIDE is a visual IDE prototype for understanding unfamiliar codebases through an object/data-flow graph instead of file-by-file keyword chasing.

This first version uses:

- `pywebview` for the desktop shell
- Python for local code scanning
- HTML/CSS/JavaScript for the graph UI
- A lightweight built-in parser for Python, JavaScript, and TypeScript

## Run

Install dependencies:

```powershell
& "C:\Users\sf100\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m pip install -r requirements.txt
```

Start the app:

```powershell
& "C:\Users\sf100\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py
```

If Python is on your PATH, `python app.py` also works.

By default the app opens `examples/three_layer_import`, which is small enough to load instantly. To scan another folder:

```powershell
& "C:\Users\sf100\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py C:\path\to\project
```

Use `--debug` only when you need pywebview developer debugging:

```powershell
& "C:\Users\sf100\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py examples\three_layer_import --debug
```

## What Works Now

- Scan a folder into a code graph
- Detect files, classes, functions, imports, and simple call references
- Resolve local Python imports to module-to-module graph edges
- Search nodes
- Focus a node and fade unrelated nodes
- Collapse or expand a file/module node
- Inspect incoming and outgoing relationships

## Responsiveness Guards

- Scans ignore dependency/cache folders such as `.git`, `node_modules`, `.venv`, `.next`, and `site-packages`
- Scans cap the first pass at 600 files
- Files larger than 512 KB are skipped
- The graph renders the highest-priority 360 nodes first, prioritizing selected, neighboring, and searched nodes

## Next Good Steps

- Replace the regex scanner with Tree-sitter
- Add a real code preview panel
- Add LSP-powered symbol references
- Add AI summaries for selected graph neighborhoods
- Persist `.uidegraph.json` project maps
