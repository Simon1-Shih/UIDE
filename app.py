from __future__ import annotations

import json
import re
import sys
import traceback
import importlib.util
import inspect
import ast
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import webview
except ImportError:
    webview = None


ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"

IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    ".nuxt",
    ".turbo",
    "coverage",
    "htmlcov",
    "site-packages",
    "vendor",
}

SUPPORTED_EXTENSIONS = {".py", ".js", ".jsx", ".ts", ".tsx"}
MAX_SCAN_FILES = 600
MAX_FILE_BYTES = 512_000
CACHE_VERSION = 3


@dataclass
class GraphBuilder:
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    edges: dict[str, dict[str, Any]] = field(default_factory=dict)

    def node(self, node_id: str, kind: str, name: str, **metadata: Any) -> None:
        if node_id in self.nodes:
            self.nodes[node_id].update(metadata)
            return
        self.nodes[node_id] = {
            "id": node_id,
            "kind": kind,
            "name": name,
            "metadata": metadata,
        }

    def edge(self, source: str, target: str, kind: str, label: str | None = None) -> None:
        if source == target:
            return
        edge_id = f"{source}->{target}:{kind}"
        if edge_id in self.edges:
            return
        self.edges[edge_id] = {
            "id": edge_id,
            "source": source,
            "target": target,
            "kind": kind,
            "label": label or kind,
        }


class CodeScanner:
    def __init__(self) -> None:
        self.cache_dir = ROOT / ".uide_cache"
        self.cache_file = self.cache_dir / "cache.json"
        self.cache_data = self._load_cache()

    def _load_cache(self) -> dict[str, Any]:
        if self.cache_file.exists():
            try:
                return json.loads(self.cache_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _save_cache(self) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.cache_file.write_text(json.dumps(self.cache_data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def scan(self, folder: str) -> dict[str, Any]:
        root = Path(folder).expanduser().resolve()
        if not root.exists() or not root.is_dir():
            raise ValueError(f"Folder does not exist: {root}")

        builder = GraphBuilder()
        project_id = "project"
        builder.node(project_id, "project", root.name, path=str(root))

        files = list(self._iter_files(root))
        skipped_files = 0
        if len(files) > MAX_SCAN_FILES:
            skipped_files = len(files) - MAX_SCAN_FILES
            files = files[:MAX_SCAN_FILES]
        module_index = self._build_module_index(root, files)
        symbol_index: dict[str, list[str]] = {}
        file_text: dict[str, str] = {}
        file_words: dict[str, set[str]] = {}

        cache_updated = False

        for file_path in files:
            rel = file_path.relative_to(root).as_posix()
            file_id = f"file:{rel}"

            path_str = str(file_path)
            try:
                stat = file_path.stat()
                mtime = stat.st_mtime
                size = stat.st_size
            except OSError:
                mtime = 0
                size = 0

            cached = self.cache_data.get(path_str)
            if cached and cached.get("version") == CACHE_VERSION and cached.get("mtime") == mtime and cached.get("size") == size:
                symbols = cached["symbols"]
                imports = cached["imports"]
                words = set(cached["words"])
                text = self._read_text(file_path)
            else:
                text = self._read_text(file_path)
                symbols = self._extract_symbols(text, file_path.suffix)
                imports = self._extract_imports(text, file_path.suffix)
                words = set(re.findall(r'\b[A-Za-z_][A-Za-z0-9_]*\b', text))

                self.cache_data[path_str] = {
                    "mtime": mtime,
                    "size": size,
                    "version": CACHE_VERSION,
                    "symbols": symbols,
                    "imports": imports,
                    "words": list(words)
                }
                cache_updated = True

            file_text[file_id] = text
            file_words[file_id] = words

            builder.node(file_id, "module", file_path.name, path=str(file_path), relpath=rel)
            parent_id = self._folder_node(builder, project_id, root, file_path)
            builder.edge(parent_id, file_id, "contains", "contains")

            class_ids: dict[str, str] = {}
            for symbol in symbols:
                owner_prefix = f"{symbol.get('ownerClass')}." if symbol.get("ownerClass") else ""
                symbol_id = f"{symbol['kind']}:{rel}:{owner_prefix}{symbol['name']}"
                if symbol["kind"] == "class":
                    class_ids[symbol["name"]] = symbol_id
                builder.node(
                    symbol_id,
                    symbol["kind"],
                    symbol["name"],
                    path=str(file_path),
                    relpath=rel,
                    line=symbol["line"],
                    signature=symbol.get("signature", ""),
                    params=symbol.get("params", []),
                    ownerClass=symbol.get("ownerClass", ""),
                    ownerParams=symbol.get("ownerParams", []),
                    isMethod=symbol.get("isMethod", False),
                )
                containing_node_id = class_ids.get(symbol.get("ownerClass", "")) or file_id
                builder.edge(containing_node_id, symbol_id, "contains", "contains")
                symbol_index.setdefault(symbol["name"], []).append(symbol_id)

            for import_name in imports:
                import_id = f"import:{rel}:{import_name}"
                builder.node(import_id, "import", import_name, path=str(file_path), relpath=rel)
                builder.edge(file_id, import_id, "imports", "imports")
                target_file_id = module_index.get(import_name)
                if target_file_id:
                    builder.edge(file_id, target_file_id, "imports", f"imports {import_name}")

        for file_id, text in file_text.items():
            words = file_words[file_id]
            for name, targets in symbol_index.items():
                if name not in words:
                    continue
                if not re.search(rf"\b{re.escape(name)}\s*\(", text):
                    continue
                for target in targets:
                    rel_from_id = self._rel_from_file_id(file_id)
                    if target.startswith(f"class:{rel_from_id}:") or target.startswith(f"function:{rel_from_id}:") or target.startswith(
                        f"method:{rel_from_id}:"
                    ):
                        continue
                    builder.edge(file_id, target, "calls", "calls")

        if cache_updated:
            self._save_cache()

        return {
            "root": str(root),
            "stats": {
                "files": len(files),
                "nodes": len(builder.nodes),
                "edges": len(builder.edges),
                "skippedFiles": skipped_files,
                "maxFiles": MAX_SCAN_FILES,
            },
            "nodes": list(builder.nodes.values()),
            "edges": list(builder.edges.values()),
        }

    def _folder_node(self, builder: GraphBuilder, project_id: str, root: Path, file_path: Path) -> str:
        rel_parts = file_path.relative_to(root).parts
        if len(rel_parts) <= 1:
            folder_name = "./"
            folder_id = "folder:."
            builder.node(folder_id, "folder", folder_name, path=str(root), relpath=".")
            builder.edge(project_id, folder_id, "contains", "contains")
            return folder_id
        folder_name = rel_parts[0]
        folder_id = f"folder:{folder_name}"
        builder.node(folder_id, "folder", folder_name, path=str(root / folder_name), relpath=folder_name)
        builder.edge(project_id, folder_id, "contains", "contains")
        return folder_id

    def _iter_files(self, root: Path):
        for path in root.rglob("*"):
            if any(part in IGNORED_DIRS for part in path.parts):
                continue
            if path.is_file() and path.suffix in SUPPORTED_EXTENSIONS and self._is_reasonable_file(path):
                yield path

    def _is_reasonable_file(self, path: Path) -> bool:
        try:
            return path.stat().st_size <= MAX_FILE_BYTES
        except OSError:
            return False

    def _read_text(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return path.read_text(encoding="utf-8", errors="ignore")

    def _build_module_index(self, root: Path, files: list[Path]) -> dict[str, str]:
        module_index: dict[str, str] = {}
        for file_path in files:
            if file_path.suffix != ".py":
                continue
            rel = file_path.relative_to(root).as_posix()
            file_id = f"file:{rel}"
            parts = list(file_path.relative_to(root).with_suffix("").parts)
            if parts[-1] == "__init__":
                parts = parts[:-1]
            if not parts:
                continue
            module_index[".".join(parts)] = file_id
        return module_index

    def _extract_symbols(self, text: str, suffix: str) -> list[dict[str, Any]]:
        if suffix == ".py":
            return self._extract_python_symbols(text)
        return self._extract_js_symbols(text)

    def _extract_python_symbols(self, text: str) -> list[dict[str, Any]]:
        try:
            return self._extract_python_symbols_ast(text)
        except SyntaxError:
            pass

        symbols: list[dict[str, Any]] = []
        patterns = [
            ("class", re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?:", re.MULTILINE)),
            (
                "function",
                re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))\s*:", re.MULTILINE),
            ),
        ]
        for kind, pattern in patterns:
            for match in pattern.finditer(text):
                name = match.group(1)
                symbols.append(
                    {
                        "kind": kind,
                        "name": name,
                        "line": text.count("\n", 0, match.start()) + 1,
                        "signature": self._class_init_signature(text, name) if kind == "class" else match.group(0).strip(),
                    }
                )
        return symbols

    def _extract_python_symbols_ast(self, text: str) -> list[dict[str, Any]]:
        tree = ast.parse(text)
        class_params: dict[str, list[dict[str, Any]]] = {}
        symbols: list[dict[str, Any]] = []

        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                params = self._class_init_params(node)
                class_params[node.name] = params
                symbols.append(
                    {
                        "kind": "class",
                        "name": node.name,
                        "line": node.lineno,
                        "signature": self._signature_text(node.name, params, include_self=False),
                        "params": params,
                        "ownerClass": "",
                        "isMethod": False,
                    }
                )

        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                params = self._function_params(node)
                symbols.append(
                    {
                        "kind": "function",
                        "name": node.name,
                        "line": node.lineno,
                        "signature": self._signature_text(node.name, params, include_self=True),
                        "params": params,
                        "ownerClass": "",
                        "isMethod": False,
                    }
                )
            elif isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name != "__init__":
                        params = self._function_params(item)
                        symbols.append(
                            {
                                "kind": "method",
                                "name": item.name,
                                "line": item.lineno,
                                "signature": self._signature_text(item.name, params, include_self=True),
                                "params": params,
                                "ownerClass": node.name,
                                "ownerParams": class_params.get(node.name, []),
                                "isMethod": True,
                            }
                        )
        return symbols

    def _class_init_params(self, class_node: ast.ClassDef) -> list[dict[str, Any]]:
        for item in class_node.body:
            if isinstance(item, ast.FunctionDef) and item.name == "__init__":
                return self._function_params(item)
        return []

    def _function_params(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict[str, Any]]:
        params: list[dict[str, Any]] = []
        positional = list(node.args.posonlyargs) + list(node.args.args)
        defaults = [None] * (len(positional) - len(node.args.defaults)) + list(node.args.defaults)
        for arg, default in zip(positional, defaults):
            params.append(self._param_info(arg, default))
        if node.args.vararg:
            params.append(self._param_info(node.args.vararg, None, prefix="*"))
        kw_defaults = list(node.args.kw_defaults)
        for arg, default in zip(node.args.kwonlyargs, kw_defaults):
            params.append(self._param_info(arg, default, keyword_only=True))
        if node.args.kwarg:
            params.append(self._param_info(node.args.kwarg, None, prefix="**"))
        return params

    def _param_info(
        self,
        arg: ast.arg,
        default: ast.AST | None,
        prefix: str = "",
        keyword_only: bool = False,
    ) -> dict[str, Any]:
        return {
            "name": f"{prefix}{arg.arg}",
            "type": self._annotation_text(arg.annotation),
            "default": self._default_text(default),
            "required": default is None,
            "keywordOnly": keyword_only,
        }

    def _default_text(self, default: ast.AST | None) -> str:
        if default is None:
            return ""
        try:
            return ast.unparse(default)
        except Exception:
            return "..."

    def _signature_text(self, name: str, params: list[dict[str, Any]], include_self: bool) -> str:
        parts = []
        for param in params:
            param_name = param["name"]
            if not include_self and param_name in {"self", "cls"}:
                continue
            item = param_name
            if param.get("type"):
                item += f": {param['type']}"
            if param.get("default"):
                item += f" = {param['default']}"
            parts.append(item)
        return f"{name}({', '.join(parts)})"

    def _class_init_signature(self, text: str, class_name: str) -> str:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return f"class {class_name}()"
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for item in node.body:
                    if isinstance(item, ast.FunctionDef) and item.name == "__init__":
                        params = []
                        for arg in item.args.args:
                            annotation = self._annotation_text(arg.annotation)
                            params.append(f"{arg.arg}: {annotation}" if annotation else arg.arg)
                        return f"{class_name}({', '.join(params)})"
        return f"class {class_name}()"

    def _annotation_text(self, annotation: ast.AST | None) -> str:
        if annotation is None:
            return ""
        try:
            return ast.unparse(annotation)
        except Exception:
            return ""

    def _extract_js_symbols(self, text: str) -> list[dict[str, Any]]:
        symbols: list[dict[str, Any]] = []
        patterns = [
            ("class", re.compile(r"\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)")),
            (
                "function",
                re.compile(
                    r"\b(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)|\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>"
                ),
            ),
        ]
        for kind, pattern in patterns:
            for match in pattern.finditer(text):
                name = match.group(1) or match.group(2)
                symbols.append(
                    {
                        "kind": kind,
                        "name": name,
                        "line": text.count("\n", 0, match.start()) + 1,
                        "signature": match.group(0).strip().split("{")[0],
                    }
                )
        return symbols

    def _extract_imports(self, text: str, suffix: str) -> list[str]:
        imports: set[str] = set()
        if suffix == ".py":
            try:
                tree = ast.parse(text)
            except SyntaxError:
                return sorted(imports)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imports.add(alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imports.add(node.module)
        else:
            for match in re.finditer(r"\bfrom\s+['\"]([^'\"]+)['\"]|\bimport\s+['\"]([^'\"]+)['\"]", text):
                imports.add(match.group(1) or match.group(2))
        return sorted(imports)

    def _rel_from_file_id(self, file_id: str) -> str:
        return file_id.removeprefix("file:")


class Api:
    def __init__(self, initial_project_path: str | None = None) -> None:
        self.scanner = CodeScanner()
        self.config_file = ROOT / ".uide_config.json"
        self.config = self._load_config()

        # Clean up old txt config if it exists
        old_txt = ROOT / ".uide_last_project.txt"
        if old_txt.exists():
            try:
                old_txt.unlink()
            except Exception:
                pass

        saved_path = self.config.get("last_project")
        self.initial_project_path = initial_project_path or saved_path or str(ROOT / "examples" / "three_layer_import")
        # Keep pywebview's native window private; public API fields are exposed to JavaScript.
        self._window = None

    def _load_config(self) -> dict[str, Any]:
        if self.config_file.exists():
            try:
                return json.loads(self.config_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _save_config(self) -> None:
        try:
            self.config_file.write_text(json.dumps(self.config, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def get_config(self) -> dict[str, Any]:
        return self.config

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        self.config.update(updates)
        self._save_config()
        return {"ok": True}

    def scan_project(self, path: str | None = None) -> dict[str, Any]:
        try:
            target = path
            if not target:
                saved_path = self.config.get("last_project")
                if saved_path and Path(saved_path).is_dir():
                    target = saved_path
            if not target:
                target = self.initial_project_path

            graph = self.scanner.scan(target)

            # Save the successful path to config
            self.config["last_project"] = target
            self._save_config()

            return {"ok": True, "graph": graph}
        except Exception as exc:
            return {"ok": False, "error": f"{exc}\n{traceback.format_exc()}"}

    def choose_folder(self) -> dict[str, Any]:
        if not self._window:
            return {"ok": False, "error": "Window is not ready."}
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return {"ok": False, "cancelled": True}
        return self.scan_project(result[0])

    def save_graph(self, graph: dict[str, Any], path: str | None = None) -> dict[str, Any]:
        try:
            target = Path(path or ROOT / ".uidegraph.json")
            target.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
            return {"ok": True, "path": str(target)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def run_python_mock(self, request: dict[str, Any]) -> dict[str, Any]:
        try:
            project_root = Path(request["projectRoot"]).resolve()
            relpath = str(request["relpath"])
            symbol_name = str(request["symbolName"])
            kind = str(request.get("kind", "function"))
            args = request.get("args", {})
            owner_args = request.get("ownerArgs", {})
            owner_class = str(request.get("ownerClass", ""))
            file_path = (project_root / relpath).resolve()
            try:
                file_path.relative_to(project_root)
            except ValueError:
                raise ValueError("Refusing to execute outside the scanned project.")
            if file_path.suffix != ".py":
                raise ValueError("Quick Mock execution currently supports Python files only.")
            if not file_path.exists():
                raise ValueError(f"Python file does not exist: {file_path}")

            previous_cwd = Path.cwd()
            os.chdir(project_root)
            try:
                target = None
                module = None
                load_error: Exception | None = None
                try:
                    module = self._load_python_module(project_root, file_path)
                    target = getattr(module, symbol_name, None)
                    if target is None:
                        target = self._find_class_member(module, symbol_name)
                except ModuleNotFoundError as exc:
                    load_error = exc
                    target = self._load_isolated_python_symbol(file_path, symbol_name)
                if target is None:
                    detail = f" Load failed first: {load_error}" if load_error else ""
                    raise ValueError(f"{symbol_name} is not a top-level symbol or class member in {relpath}.{detail}")
                if owner_class and kind in {"function", "method"}:
                    owner = getattr(module, owner_class, None) if module else None
                    if owner is None:
                        owner = self._load_isolated_python_symbol(file_path, owner_class)
                    if not isinstance(owner, type):
                        raise ValueError(f"Cannot build self because {owner_class} is not available as a class.")
                    owner_kwargs = {
                        name: self._coerce_mock_value(value.get("value"), value.get("type", ""), module)
                        for name, value in owner_args.items()
                    }
                    target = getattr(owner(**owner_kwargs), symbol_name)

                kwargs = {
                    name: self._coerce_mock_value(value.get("value"), value.get("type", ""), module)
                    for name, value in args.items()
                    if name not in {"self", "cls"}
                }
                if kind == "class":
                    result = target(**kwargs)
                else:
                    result = target(**kwargs)
            finally:
                os.chdir(previous_cwd)
            return {"ok": True, "result": repr(result), "resultType": type(result).__name__}
        except Exception as exc:
            return {"ok": False, "error": f"{exc}\n{traceback.format_exc()}"}

    def _load_python_module(self, project_root: Path, file_path: Path):
        module_name = f"_uide_mock_{abs(hash(str(file_path)))}"
        added_paths = []
        for candidate in (project_root, project_root.parent):
            candidate_text = str(candidate)
            if candidate_text not in sys.path:
                sys.path.insert(0, candidate_text)
                added_paths.append(candidate_text)
        try:
            spec = importlib.util.spec_from_file_location(module_name, file_path)
            if spec is None or spec.loader is None:
                raise ValueError(f"Cannot load module from {file_path}")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        finally:
            for path in added_paths:
                try:
                    sys.path.remove(path)
                except ValueError:
                    pass

    def _find_class_member(self, module: Any, symbol_name: str) -> Any:
        for value in vars(module).values():
            if isinstance(value, type) and hasattr(value, symbol_name):
                return getattr(value, symbol_name)
        return None

    def _load_isolated_python_symbol(self, file_path: Path, symbol_name: str) -> Any:
        tree = ast.parse(file_path.read_text(encoding="utf-8", errors="ignore"))
        namespace: dict[str, Any] = {
            "__builtins__": __builtins__,
            "__name__": "_uide_isolated_mock",
            "subprocess": __import__("subprocess"),
            "time": __import__("time"),
        }
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == symbol_name:
                exec(compile(ast.Module(body=[node], type_ignores=[]), str(file_path), "exec"), namespace)
                return namespace.get(symbol_name)
            if isinstance(node, ast.ClassDef):
                if node.name == symbol_name:
                    exec(compile(ast.Module(body=[node], type_ignores=[]), str(file_path), "exec"), namespace)
                    return namespace.get(symbol_name)
                method_names = {item.name for item in node.body if isinstance(item, ast.FunctionDef)}
                if symbol_name in method_names:
                    exec(compile(ast.Module(body=[node], type_ignores=[]), str(file_path), "exec"), namespace)
                    cls = namespace.get(node.name)
                    return getattr(cls, symbol_name, None)
        return None

    def _coerce_mock_value(self, value: Any, type_hint: str, module: Any | None = None) -> Any:
        if isinstance(value, dict):
            if "dict" in type_hint.lower() or not type_hint:
                return value
            return self._coerce_custom_object(value, type_hint, module)
        if isinstance(value, list):
            return value
        text = "" if value is None else str(value)
        hint = type_hint.lower()
        if "int" in hint:
            return int(text)
        if "float" in hint:
            return float(text)
        if "bool" in hint:
            return text.lower() in {"1", "true", "yes", "y", "on"}
        if "list" in hint or "dict" in hint or text.startswith(("[", "{")):
            parsed = json.loads(text)
            if "dict" in hint or not type_hint or isinstance(parsed, list):
                return parsed
            return self._coerce_custom_object(parsed, type_hint, module)
        return text

    def _coerce_custom_object(self, value: Any, type_hint: str, module: Any | None) -> Any:
        if not isinstance(value, dict) or module is None:
            return value
        class_name = self._mock_class_name(type_hint)
        cls = getattr(module, class_name, None)
        if not isinstance(cls, type):
            return value
        signature = inspect.signature(cls)
        kwargs = {}
        for name, param in signature.parameters.items():
            if name in {"self", "cls"} or name not in value:
                continue
            annotation = "" if param.annotation is inspect._empty else getattr(param.annotation, "__name__", str(param.annotation))
            kwargs[name] = self._coerce_mock_value(value[name], annotation, module)
        return cls(**kwargs)

    def _mock_class_name(self, type_hint: str) -> str:
        name = type_hint.strip().strip("'\"")
        optional_match = re.match(r"(?:typing\.)?Optional\[(.+)\]$", name)
        if optional_match:
            name = optional_match.group(1)
        if "|" in name:
            name = next(part.strip() for part in name.split("|") if part.strip() not in {"None", "NoneType"})
        if "[" in name:
            name = name.split("[", 1)[0]
        return name.split(".")[-1].strip()


def main() -> int:
    if webview is None:
        print("pywebview is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 1

    initial_project_path = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "examples" / "three_layer_import")
    api = Api(initial_project_path)
    html = WEB_DIR / "index.html"
    window = webview.create_window(
        "UIDE - Visual OOP Code Atlas",
        url=str(html),
        js_api=api,
        width=1440,
        height=920,
        min_size=(1100, 720),
    )
    api._window = window
    webview.start(debug="--debug" in sys.argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
