const state = {
  graph: null,
  positions: new Map(),
  selectedId: null,
  collapsed: new Set(),
  query: "",
  dragging: null,
  panning: null,
  pan: { x: 0, y: 0 },
  zoom: 1,
  renderIds: new Set(),
  mock: null,
  resizing: null,
};

const MAX_RENDER_NODES = 360;

const els = {
  pathInput: document.querySelector("#pathInput"),
  scanButton: document.querySelector("#scanButton"),
  chooseButton: document.querySelector("#chooseButton"),
  stats: document.querySelector("#stats"),
  searchInput: document.querySelector("#searchInput"),
  nodeList: document.querySelector("#nodeList"),
  graph: document.querySelector("#graph"),
  nodes: document.querySelector("#nodes"),
  edges: document.querySelector("#edges"),
  subtitle: document.querySelector("#subtitle"),
  fitButton: document.querySelector("#fitButton"),
  clearFocusButton: document.querySelector("#clearFocusButton"),
  inspectorEmpty: document.querySelector("#inspectorEmpty"),
  inspectorBody: document.querySelector("#inspectorBody"),
  selectedKind: document.querySelector("#selectedKind"),
  selectedName: document.querySelector("#selectedName"),
  selectedPath: document.querySelector("#selectedPath"),
  outgoing: document.querySelector("#outgoing"),
  incoming: document.querySelector("#incoming"),
  mockButton: document.querySelector("#mockButton"),
  mockBody: document.querySelector("#mockBody"),
  leftResizer: document.querySelector("#leftResizer"),
  rightResizer: document.querySelector("#rightResizer"),
  contextSeed: document.querySelector("#contextSeed"),
};

const sampleGraph = {
  root: "Demo",
  stats: { files: 3, nodes: 12, edges: 15 },
  nodes: [
    node("project", "project", "Demo"),
    node("file:auth.py", "module", "auth.py", { relpath: "auth.py" }),
    node("class:auth.py:AuthService", "class", "AuthService", { line: 3, relpath: "auth.py" }),
    node("function:auth.py:login", "function", "login", { line: 7, relpath: "auth.py" }),
    node("file:user.py", "module", "user.py", { relpath: "user.py" }),
    node("class:user.py:UserRepository", "class", "UserRepository", { line: 4, relpath: "user.py" }),
    node("function:user.py:find_user", "function", "find_user", { line: 8, relpath: "user.py" }),
    node("file:guard.ts", "module", "guard.ts", { relpath: "guard.ts" }),
    node("function:guard.ts:canAccess", "function", "canAccess", { line: 5, relpath: "guard.ts" }),
    node("import:auth.py:jwt", "import", "jwt", { relpath: "auth.py" }),
  ],
  edges: [
    edge("project", "file:auth.py", "contains"),
    edge("project", "file:user.py", "contains"),
    edge("project", "file:guard.ts", "contains"),
    edge("file:auth.py", "class:auth.py:AuthService", "contains"),
    edge("file:auth.py", "function:auth.py:login", "contains"),
    edge("file:user.py", "class:user.py:UserRepository", "contains"),
    edge("file:user.py", "function:user.py:find_user", "contains"),
    edge("file:guard.ts", "function:guard.ts:canAccess", "contains"),
    edge("file:auth.py", "import:auth.py:jwt", "imports"),
    edge("file:auth.py", "class:user.py:UserRepository", "calls"),
    edge("function:guard.ts:canAccess", "class:auth.py:AuthService", "calls"),
  ],
};

function node(id, kind, name, metadata = {}) {
  return { id, kind, name, metadata };
}

function edge(source, target, kind) {
  return { id: `${source}->${target}:${kind}`, source, target, kind, label: kind };
}

function color(kind) {
  return {
    project: "var(--cyan)",
    folder: "#ff9f43",
    module: "var(--gold)",
    class: "var(--green)",
    function: "var(--blue)",
    import: "var(--violet)",
  }[kind] || "var(--muted)";
}

function setGraph(graph) {
  state.graph = graph;
  state.positions.clear();
  state.selectedId = null;
  state.collapsed.clear();
  for (const node of graph.nodes) {
    if (node.kind === "module") state.collapsed.add(node.id);
  }
  state.renderIds.clear();
  state.mock = null;
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  layoutGraph();
  render();
}

function layoutGraph() {
  const rect = els.graph.getBoundingClientRect();
  const visible = visibleNodeIds();
  const nodes = state.graph.nodes.filter((node) => visible.has(node.id));
  const layers = {
    project: nodes.filter((n) => n.kind === "project"),
    folder: nodes.filter((n) => n.kind === "folder"),
    module: nodes.filter((n) => n.kind === "module"),
    class: nodes.filter((n) => n.kind === "class"),
    function: nodes.filter((n) => n.kind === "function"),
    import: nodes.filter((n) => n.kind === "import"),
  };
  const layerOrder = ["project", "folder", "module", "class", "function", "import"];
  const centerY = Math.max(260, rect.height / 2);
  const startX = 80;
  const gapX = Math.max(190, (rect.width - 220) / Math.max(1, layerOrder.length - 1));

  layerOrder.forEach((kind, layerIndex) => {
    const items = layers[kind] || [];
    const spacing = Math.max(78, Math.min(128, (rect.height - 160) / Math.max(1, items.length)));
    const total = (items.length - 1) * spacing;
    items.forEach((item, index) => {
      const depth = layerIndex * 11;
      state.positions.set(item.id, {
        x: startX + layerIndex * gapX + depth,
        y: centerY - total / 2 + index * spacing - depth * 0.55,
      });
    });
  });
}

function visibleNodeIds() {
  if (!state.graph) return new Set();
  return new Set(state.graph.nodes.filter((node) => !isNodeHiddenByCollapsedFile(node)).map((node) => node.id));
}

function isNodeHiddenByCollapsedFile(node) {
  if (node.kind === "project" || node.kind === "module") return false;
  const relpath = node.metadata?.relpath;
  if (!relpath) return false;
  return state.collapsed.has(`file:${relpath}`);
}

function relatedIds(id) {
  if (!id || !state.graph) return new Set();
  const ids = new Set([id]);
  for (const edge of state.graph.edges) {
    if (edge.source === id) ids.add(edge.target);
    if (edge.target === id) ids.add(edge.source);
  }
  return ids;
}

function render() {
  if (!state.graph) return;
  updateRenderScope();
  renderStats();
  renderList();
  renderNodes();
  renderEdges();
  renderInspector();
}

function renderStats() {
  const stats = state.graph.stats;
  els.stats.innerHTML = [
    stat(stats.files, "Files"),
    stat(stats.nodes, "Nodes"),
    stat(stats.edges, "Edges"),
  ].join("");
  const skipped = stats.skippedFiles ? ` - skipped ${stats.skippedFiles} files after ${stats.maxFiles}` : "";
  const limited = state.renderIds.size < state.graph.nodes.length ? ` - showing ${state.renderIds.size}/${state.graph.nodes.length} nodes` : "";
  els.subtitle.textContent = `${state.graph.root}${skipped}${limited}`;
  els.pathInput.value = state.graph.root;
}

function stat(value, label) {
  return `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`;
}

function renderList() {
  const q = state.query.toLowerCase();
  const visible = visibleNodeIds();
  const sourceNodes = q ? state.graph.nodes : state.graph.nodes.filter((n) => visible.has(n.id) && state.renderIds.has(n.id));
  const rows = sourceNodes
    .filter((n) => !q || nodeSearchText(n).includes(q))
    .slice(0, 180)
    .map((n) => {
      const canCollapse = n.kind === "module";
      const mark = state.collapsed.has(n.id) ? "+" : "-";
      return `
        <div class="node-row ${state.selectedId === n.id ? "active" : ""}" data-id="${n.id}" role="button" tabindex="0">
          <span class="swatch ${n.kind}"></span>
          <span><strong>${escapeHtml(n.name)}</strong><small>${escapeHtml(n.kind)} - ${escapeHtml(n.metadata?.relpath || "")}</small></span>
          ${canCollapse ? `<button class="collapse-toggle" data-collapse="${n.id}" title="Collapse module">${mark}</button>` : "<span></span>"}
        </div>
      `;
    })
    .join("");
  els.nodeList.innerHTML = rows || `<div class="empty">No matching nodes.</div>`;
}

function nodeSearchText(node) {
  return `${node.name} ${node.kind} ${node.metadata?.relpath || ""} ${node.metadata?.signature || ""}`.toLowerCase();
}

function renderNodes() {
  const visible = visibleNodeIds();
  const selectedNeighbors = relatedIds(state.selectedId);
  const mockNodeIds = new Set(state.mock?.steps.map((step) => step.nodeId) || []);
  els.nodes.innerHTML = "";
  for (const n of state.graph.nodes) {
    if (!state.renderIds.has(n.id)) continue;
    const pos = state.positions.get(n.id);
    if (!pos) continue;
    const el = document.createElement("div");
    el.className = [
      "node",
      state.selectedId === n.id ? "active" : "",
      mockNodeIds.has(n.id) ? "mock-node" : "",
      state.selectedId && !selectedNeighbors.has(n.id) ? "dim" : "",
      !visible.has(n.id) ? "hidden" : "",
    ].join(" ");
    el.dataset.id = n.id;
    el.style.left = `${screenX(pos.x)}px`;
    el.style.top = `${screenY(pos.y)}px`;
    el.style.transform = `translateZ(${depthFor(n.kind)}px) scale(${state.zoom})`;
    el.innerHTML = `
      <span class="node-orb kind-${n.kind}"></span>
      <span><strong>${escapeHtml(n.name)}</strong><small>${escapeHtml(n.kind)}</small></span>
    `;
    els.nodes.appendChild(el);
  }
}

function renderEdges() {
  const visible = visibleNodeIds();
  const focusedEdgeIds = focusEdgeIds(state.selectedId);
  const mockActiveEdgeIds = activeMockEdgeIds();
  const mockPathEdgeIds = new Set(state.mock?.steps.map((step) => step.edgeId).filter(Boolean) || []);
  els.edges.innerHTML = "";
  for (const e of state.graph.edges) {
    if (!state.renderIds.has(e.source) || !state.renderIds.has(e.target)) continue;
    if (!visible.has(e.source) || !visible.has(e.target)) continue;
    const source = centerOf(e.source);
    const target = centerOf(e.target);
    if (!source || !target) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midX = (source.x + target.x) / 2;
    path.setAttribute("d", `M ${source.x} ${source.y} C ${midX} ${source.y}, ${midX} ${target.y}, ${target.x} ${target.y}`);
    const isFocused = !state.selectedId || focusedEdgeIds.has(e.id) || mockPathEdgeIds.has(e.id);
    path.setAttribute("class", [
      "edge",
      e.kind,
      state.selectedId && !isFocused ? "dim" : "",
      mockPathEdgeIds.has(e.id) ? "mock-pending" : "",
      mockActiveEdgeIds.has(e.id) ? "mock-flow" : "",
    ].join(" "));
    els.edges.appendChild(path);
  }
}

function renderInspector() {
  const selected = state.graph.nodes.find((n) => n.id === state.selectedId);
  els.inspectorEmpty.classList.toggle("hidden", Boolean(selected));
  els.inspectorBody.classList.toggle("hidden", !selected);
  if (!selected) return;
  els.selectedKind.textContent = selected.kind;
  els.selectedName.textContent = selected.name;
  els.selectedPath.textContent = selected.metadata?.relpath || selected.metadata?.path || "";
  els.outgoing.innerHTML = relationRows(state.graph.edges.filter((e) => e.source === selected.id), "target");
  els.incoming.innerHTML = relationRows(state.graph.edges.filter((e) => e.target === selected.id), "source");
  renderMockPanel(selected.id);
  els.contextSeed.textContent = JSON.stringify(buildContext(selected.id), null, 2);
}

function focusEdgeIds(id) {
  if (!id || !state.graph) return new Set();
  return new Set(state.graph.edges.filter((edge) => edge.source === id || edge.target === id).map((edge) => edge.id));
}

function activeMockEdgeIds() {
  if (!state.mock) return new Set();
  return new Set(
    state.mock.steps
      .slice(0, state.mock.step + 1)
      .map((step) => step.edgeId)
      .filter(Boolean),
  );
}

function renderMockPanel(selectedId) {
  if (!els.mockBody) return;
  if (!state.mock || state.mock.nodeId !== selectedId) {
    els.mockBody.innerHTML = `<div class="mock-summary">Trace this node to infer the upstream objects and input values needed for a quick mock.</div>`;
    return;
  }
  const steps = state.mock.steps
    .map((step, index) => {
      const fields = step.params.length ? renderMockFields(step) : `<div class="mock-fill">No parameters required.</div>`;
      const result = step.result ? `<div class="mock-result ${step.result.ok ? "ok" : "error"}">${escapeHtml(step.result.text)}</div>` : "";
      return `
        <div class="mock-step ${index <= state.mock.step ? "active" : ""}">
          <span class="mock-index">${index + 1}</span>
          <div>
            <strong>${escapeHtml(step.title)}</strong>
            <div>${escapeHtml(step.detail)}</div>
            ${index === state.mock.step ? fields : ""}
            ${index === state.mock.step ? `<button class="run-step-button" data-run-step="${index}">Run Step</button>` : ""}
            ${result}
          </div>
        </div>
      `;
    })
    .join("");
  els.mockBody.innerHTML = `
    <div class="mock-summary">${escapeHtml(state.mock.summary)}</div>
    <div class="mock-controls">
      <button id="mockPrevButton">Prev</button>
      <button id="mockNextButton">Next</button>
    </div>
    ${steps}
  `;
}

function renderMockFields(step) {
  return `
    <div class="mock-form">
      ${step.params
        .map((param) => {
          const value = step.values[param.name] ?? defaultValueFor(param.name, param.type);
          return `
            <label>
              <span>${escapeHtml(param.name)}${param.type ? `: ${escapeHtml(param.type)}` : ""}</span>
              <input data-mock-param="${escapeHtml(param.name)}" value="${escapeHtml(value)}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

function updateRenderScope() {
  const neighbors = relatedIds(state.selectedId);
  const mockNodeIds = new Set(state.mock?.steps.map((step) => step.nodeId) || []);
  const visible = visibleNodeIds();
  const kindScore = { project: 60, folder: 50, module: 40, class: 30, function: 20, import: 10 };
  const ranked = state.graph.nodes
    .filter((node) => visible.has(node.id))
    .map((node, index) => {
      const score =
        (node.id === state.selectedId ? 1000 : 0) +
        (mockNodeIds.has(node.id) ? 800 : 0) +
        (neighbors.has(node.id) ? 500 : 0) +
        (kindScore[node.kind] || 0);
      return { node, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_RENDER_NODES)
    .map((item) => item.node.id);
  state.renderIds = new Set(ranked);
}

function relationRows(edges, direction) {
  if (!edges.length) return `<div class="empty">No relationships.</div>`;
  return edges
    .map((edge) => {
      const target = state.graph.nodes.find((n) => n.id === edge[direction]);
      return `<div class="relation"><span>${escapeHtml(edge.kind)}</span><button data-id="${edge[direction]}">${escapeHtml(target?.name || edge[direction])}</button></div>`;
    })
    .join("");
}

function buildMockPlan(nodeId) {
  const selected = findNode(nodeId);
  if (!selected) return null;
  const trace = traceMockPath(nodeId);
  const steps = trace.map((item, index) => {
    const node = findNode(item.nodeId);
    return {
      nodeId: item.nodeId,
      edgeId: item.edgeId,
      node,
      title: index === trace.length - 1 ? `Mock target: ${node?.name || item.nodeId}` : `Prepare ${node?.name || item.nodeId}`,
      detail: mockDetailFor(node, item.edge),
      params: mockParamsFor(node),
      values: {},
      result: null,
    };
  });
  if (!steps.length) {
    steps.push({
      nodeId,
      edgeId: null,
      node: selected,
      title: `Mock target: ${selected.name}`,
      detail: mockDetailFor(selected, null),
      params: mockParamsFor(selected),
      values: {},
      result: null,
    });
  }
  return {
    nodeId,
    step: 0,
    steps,
    summary: `Found ${steps.length} step${steps.length === 1 ? "" : "s"} to prepare ${selected.name}. Use Next to animate data flowing into the target.`,
  };
}

function traceMockPath(nodeId) {
  const visited = new Set();
  const path = [];
  let currentId = nodeId;
  let incomingEdge = null;

  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    path.unshift({ nodeId: currentId, edgeId: incomingEdge?.id || null, edge: incomingEdge });
    const upstream = preferredUpstreamEdge(currentId, visited);
    if (!upstream) break;
    incomingEdge = upstream;
    currentId = upstream.source;
  }

  return path;
}

function preferredUpstreamEdge(nodeId, visited) {
  const priority = { calls: 4, imports: 3, contains: 1 };
  return state.graph.edges
    .filter((edge) => edge.target === nodeId && !visited.has(edge.source))
    .sort((a, b) => (priority[b.kind] || 0) - (priority[a.kind] || 0))
    [0];
}

function mockDetailFor(node, edge) {
  if (!node) return "Unknown node.";
  const via = edge ? ` via ${edge.kind}` : "";
  if (node.kind === "class") return `Create a test double for this class${via}.`;
  if (node.kind === "function") return `Call or stub this function${via}.`;
  if (node.kind === "module") return `Import this module boundary${via}.`;
  if (node.kind === "import") return `Provide a replacement for this dependency${via}.`;
  return `Prepare this ${node.kind}${via}.`;
}

function mockParamsFor(node) {
  if (!node) return [];
  const signature = node.metadata?.signature || "";
  return extractParams(signature).filter((param) => !["self", "cls"].includes(param.name));
}

function extractParams(signature) {
  const match = String(signature).match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const withoutDefault = part.split("=")[0].trim();
      const [name, type = ""] = withoutDefault.split(":").map((item) => item.trim());
      return { name: name.replace(/^[*]+/, ""), type };
    })
    .filter((param) => param.name);
}

function mockValueFor(name, type) {
  const key = `${name} ${type}`.toLowerCase();
  if (key.includes("id")) return `"test-${name}"`;
  if (key.includes("int") || key.includes("float") || key.includes("total") || key.includes("amount")) return "1";
  if (key.includes("bool") || key.startsWith("is_") || key.startsWith("has_")) return "false";
  if (key.includes("list") || key.includes("[]")) return "[]";
  if (key.includes("dict") || key.includes("map")) return "{}";
  return `"mock-${name}"`;
}

function defaultValueFor(name, type) {
  const value = mockValueFor(name, type);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function findNode(id) {
  return state.graph?.nodes.find((node) => node.id === id);
}

function buildContext(id) {
  const selected = state.graph.nodes.find((n) => n.id === id);
  const neighborhood = relatedIds(id);
  return {
    selected,
    nearbyNodes: state.graph.nodes.filter((n) => neighborhood.has(n.id)),
    relationships: state.graph.edges.filter((e) => neighborhood.has(e.source) && neighborhood.has(e.target)),
  };
}

function centerOf(id) {
  const pos = state.positions.get(id);
  if (!pos) return null;
  return { x: screenX(pos.x) + 83 * state.zoom, y: screenY(pos.y) + 27 * state.zoom };
}

function screenX(x) {
  return x * state.zoom + state.pan.x;
}

function screenY(y) {
  return y * state.zoom + state.pan.y;
}

function depthFor(kind) {
  return { project: 58, folder: 46, module: 34, class: 24, function: 14, import: 6 }[kind] || 0;
}

function selectNode(id) {
  if (state.selectedId !== id) state.mock = null;
  state.selectedId = id;
  const node = findNode(id);
  if (node?.kind === "module") {
    toggleModule(id);
    return;
  }
  const expanded = expandContainingFile(node);
  if (expanded) layoutGraph();
  render();
}

function expandContainingFile(node) {
  const relpath = node?.metadata?.relpath;
  if (!relpath) return false;
  const moduleId = `file:${relpath}`;
  if (!state.collapsed.has(moduleId)) return false;
  state.collapsed.delete(moduleId);
  return true;
}

function toggleModule(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  layoutGraph();
  render();
}

function startMockTrace() {
  if (!state.selectedId || !state.graph) return;
  state.mock = buildMockPlan(state.selectedId);
  render();
}

function stepMock(delta) {
  if (!state.mock) return;
  state.mock.step = Math.max(0, Math.min(state.mock.steps.length - 1, state.mock.step + delta));
  render();
}

async function runMockStep(index) {
  if (!state.mock || !window.pywebview?.api) return;
  const step = state.mock.steps[index];
  if (!step?.node || !["function", "class"].includes(step.node.kind)) {
    step.result = { ok: false, text: "This step is not directly executable. Select a Python class or top-level function." };
    render();
    return;
  }
  if (!step.node.metadata?.relpath?.endsWith(".py")) {
    step.result = { ok: false, text: "Quick Mock execution currently supports Python files only." };
    render();
    return;
  }
  const inputs = document.querySelectorAll(`[data-mock-param]`);
  step.values = {};
  inputs.forEach((input) => {
    const param = input.dataset.mockParam;
    step.values[param] = input.value;
  });
  const args = {};
  for (const param of step.params) {
    args[param.name] = {
      value: step.values[param.name] ?? defaultValueFor(param.name, param.type),
      type: param.type,
    };
  }
  step.result = { ok: true, text: "Running..." };
  render();
  const result = await window.pywebview.api.run_python_mock({
    projectRoot: state.graph.root,
    relpath: step.node.metadata.relpath,
    symbolName: step.node.name,
    kind: step.node.kind,
    args,
  });
  step.result = result.ok
    ? { ok: true, text: `${result.resultType}: ${result.result}` }
    : { ok: false, text: result.error || "Execution failed." };
  render();
}

function toggleCollapse(id) {
  toggleModule(id);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

async function scanPath(path) {
  els.scanButton.textContent = "Scanning";
  els.scanButton.disabled = true;
  els.subtitle.textContent = "Scanning project...";
  try {
    if (window.pywebview?.api) {
      const result = await window.pywebview.api.scan_project(path);
      if (!result.ok) throw new Error(result.error);
      setGraph(result.graph);
    } else {
      setGraph(sampleGraph);
    }
  } catch (error) {
    alert(error.message || String(error));
    els.subtitle.textContent = "Scan failed.";
  } finally {
    els.scanButton.textContent = "Scan";
    els.scanButton.disabled = false;
  }
}

els.scanButton.addEventListener("click", () => scanPath(els.pathInput.value.trim() || null));
els.chooseButton.addEventListener("click", async () => {
  if (!window.pywebview?.api) {
    setGraph(sampleGraph);
    return;
  }
  const result = await window.pywebview.api.choose_folder();
  if (result?.ok) setGraph(result.graph);
});
els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});
els.fitButton.addEventListener("click", () => {
  if (!state.graph) return;
  layoutGraph();
  render();
});
els.clearFocusButton.addEventListener("click", () => {
  state.selectedId = null;
  state.mock = null;
  render();
});
els.mockButton.addEventListener("click", () => startMockTrace());
els.nodeList.addEventListener("wheel", (event) => {
  els.nodeList.scrollTop += event.deltaY;
  event.preventDefault();
}, { passive: false });

els.leftResizer.addEventListener("pointerdown", (event) => startColumnResize(event, "left"));
els.rightResizer.addEventListener("pointerdown", (event) => startColumnResize(event, "right"));

document.addEventListener("click", (event) => {
  if (event.target.closest("#mockPrevButton")) {
    stepMock(-1);
    return;
  }
  if (event.target.closest("#mockNextButton")) {
    stepMock(1);
    return;
  }
  const runStep = event.target.closest("[data-run-step]");
  if (runStep) {
    runMockStep(Number(runStep.dataset.runStep));
    return;
  }
  const collapse = event.target.closest("[data-collapse]");
  if (collapse) {
    event.stopPropagation();
    toggleCollapse(collapse.dataset.collapse);
    return;
  }
  const target = event.target.closest("[data-id]");
  if (target) selectNode(target.dataset.id);
});

document.addEventListener("keydown", (event) => {
  const target = event.target.closest?.("[data-id]");
  if (!target || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  selectNode(target.dataset.id);
});

els.graph.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

els.graph.addEventListener("pointerdown", (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  state.panning = {
    startX: event.clientX,
    startY: event.clientY,
    x: state.pan.x,
    y: state.pan.y,
  };
  els.graph.classList.add("panning");
  els.graph.setPointerCapture(event.pointerId);
});

els.graph.addEventListener("pointermove", (event) => {
  if (!state.panning) return;
  event.preventDefault();
  state.pan = {
    x: state.panning.x + event.clientX - state.panning.startX,
    y: state.panning.y + event.clientY - state.panning.startY,
  };
  renderNodes();
  renderEdges();
});

els.graph.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const rect = els.graph.getBoundingClientRect();
  const before = {
    x: (event.clientX - rect.left - state.pan.x) / state.zoom,
    y: (event.clientY - rect.top - state.pan.y) / state.zoom,
  };
  const nextZoom = Math.max(0.35, Math.min(2.8, state.zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
  state.zoom = nextZoom;
  state.pan = {
    x: event.clientX - rect.left - before.x * state.zoom,
    y: event.clientY - rect.top - before.y * state.zoom,
  };
  renderNodes();
  renderEdges();
}, { passive: false });

els.nodes.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const target = event.target.closest(".node");
  if (!target) return;
  const id = target.dataset.id;
  const pos = state.positions.get(id);
  state.dragging = {
    id,
    startX: event.clientX,
    startY: event.clientY,
    x: pos.x,
    y: pos.y,
  };
  target.setPointerCapture(event.pointerId);
});

els.nodes.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const drag = state.dragging;
  state.positions.set(drag.id, {
    x: drag.x + (event.clientX - drag.startX) / state.zoom,
    y: drag.y + (event.clientY - drag.startY) / state.zoom,
  });
  renderNodes();
  renderEdges();
});

document.addEventListener("pointerup", () => {
  state.dragging = null;
  state.panning = null;
  state.resizing = null;
  els.graph.classList.remove("panning");
  els.leftResizer.classList.remove("active");
  els.rightResizer.classList.remove("active");
});

document.addEventListener("pointermove", (event) => {
  if (!state.resizing) return;
  const appWidth = document.querySelector("#app").getBoundingClientRect().width;
  if (state.resizing.side === "left") {
    const width = Math.max(220, Math.min(560, state.resizing.width + event.clientX - state.resizing.startX));
    document.documentElement.style.setProperty("--left-width", `${width}px`);
  } else {
    const width = Math.max(260, Math.min(620, state.resizing.width - (event.clientX - state.resizing.startX)));
    const maxRight = Math.max(260, appWidth - 520);
    document.documentElement.style.setProperty("--right-width", `${Math.min(width, maxRight)}px`);
  }
  if (state.graph) {
    renderNodes();
    renderEdges();
  }
});

function startColumnResize(event, side) {
  event.preventDefault();
  const prop = side === "left" ? "--left-width" : "--right-width";
  const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(prop));
  state.resizing = { side, startX: event.clientX, width: current };
  event.currentTarget.classList.add("active");
  event.currentTarget.setPointerCapture(event.pointerId);
}

window.addEventListener("resize", () => {
  if (!state.graph) return;
  layoutGraph();
  render();
});

window.addEventListener("pywebviewready", () => scanPath(null), { once: true });

setTimeout(() => {
  if (!state.graph) scanPath(null);
}, 800);
