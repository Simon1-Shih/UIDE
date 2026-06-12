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
  loadedConfig: null,
  kindFilters: {
    import: true,
    class: true,
    function: true,
    method: true,
  },
};

const MAX_RENDER_NODES = 360;

const els = {
  pathInput: document.querySelector("#pathInput"),
  scanButton: document.querySelector("#scanButton"),
  chooseButton: document.querySelector("#chooseButton"),
  stats: document.querySelector("#stats"),
  searchInput: document.querySelector("#searchInput"),
  kindFilters: document.querySelectorAll("[data-kind-filter]"),
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
    method: "#8fd3ff",
    import: "var(--violet)",
  }[kind] || "var(--muted)";
}

function setGraph(graph) {
  state.graph = graph;
  state.positions.clear();
  state.selectedId = null;
  state.collapsed.clear();

  const savedCollapsed = state.loadedConfig?.collapsed_by_project?.[graph.root];
  if (savedCollapsed) {
    state.collapsed = new Set(savedCollapsed);
  } else {
    for (const node of graph.nodes) {
      if (node.kind === "module") state.collapsed.add(node.id);
    }
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
    method: nodes.filter((n) => n.kind === "method"),
    import: nodes.filter((n) => n.kind === "import"),
  };
  const layerOrder = ["project", "folder", "module", "class", "method", "function", "import"];
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
  return new Set(state.graph.nodes.filter((node) => isNodeKindVisible(node) && !isNodeHiddenByCollapse(node)).map((node) => node.id));
}

function isNodeKindVisible(node) {
  if (Object.prototype.hasOwnProperty.call(state.kindFilters, node.kind)) {
    return state.kindFilters[node.kind];
  }
  return true;
}

function isNodeHiddenByCollapse(node) {
  if (node.kind === "project" || node.kind === "folder") return false;
  const relpath = node.metadata?.relpath;
  if (!relpath) return false;

  // Check if parent folder is collapsed
  const parts = relpath.split('/');
  const folderId = parts.length > 1 ? `folder:${parts[0]}` : "folder:.";
  if (state.collapsed.has(folderId)) {
    return true;
  }

  // If the node is not a module, check if its file is collapsed
  if (node.kind !== "module") {
    if (state.collapsed.has(`file:${relpath}`)) return true;
  }

  if (node.kind === "method" && node.metadata?.ownerClass) {
    const classId = `class:${relpath}:${node.metadata.ownerClass}`;
    if (state.collapsed.has(classId)) return true;
  }

  return false;
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
  const sourceNodes = q ? state.graph.nodes.filter((node) => visible.has(node.id)) : orderedListNodes();
  const rows = sourceNodes
    .filter((n) => !q || nodeSearchText(n).includes(q))
    .slice(0, 180)
    .map((n) => {
      const canCollapse = isCollapsibleNode(n);
      const mark = state.collapsed.has(n.id) ? "+" : "-";
      const title = n.kind === "folder" ? "Collapse folder" : n.kind === "class" ? "Collapse class" : "Collapse module";
      return `
        <div class="node-row ${state.selectedId === n.id ? "active" : ""}" data-id="${n.id}" role="button" tabindex="0">
          <span class="swatch ${n.kind}"></span>
          <span><strong>${escapeHtml(n.name)}</strong><small>${escapeHtml(n.kind)} - ${escapeHtml(n.metadata?.relpath || "")}</small></span>
          ${canCollapse ? `<button class="collapse-toggle" data-collapse="${n.id}" title="${title}">${mark}</button>` : "<span></span>"}
        </div>
      `;
    })
    .join("");
  els.nodeList.innerHTML = rows || `<div class="empty">No matching nodes.</div>`;
}

function isCollapsibleNode(node) {
  return Boolean(node && ["folder", "module", "class"].includes(node.kind));
}

function orderedListNodes() {
  const visible = visibleNodeIds();
  const nodesById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map();
  for (const edge of state.graph.edges) {
    if (edge.kind !== "contains") continue;
    if (!childrenByParent.has(edge.source)) childrenByParent.set(edge.source, []);
    childrenByParent.get(edge.source).push(edge.target);
  }

  const ordered = [];
  const visited = new Set();
  const walk = (id) => {
    if (visited.has(id) || !visible.has(id)) return;
    const node = nodesById.get(id);
    if (!node) return;
    visited.add(id);
    ordered.push(node);
    for (const childId of orderedChildIds(id, childrenByParent, nodesById)) {
      walk(childId);
    }
  };

  walk("project");
  for (const node of state.graph.nodes) {
    walk(node.id);
  }
  return ordered;
}

function orderedChildIds(parentId, childrenByParent, nodesById) {
  const children = (childrenByParent.get(parentId) || [])
    .map((id) => nodesById.get(id))
    .filter(Boolean);
  const parent = nodesById.get(parentId);
  if (parent?.kind === "module") return orderedModuleChildIds(children);
  return children.sort(compareSiblingNodes).map((node) => node.id);
}

function orderedModuleChildIds(children) {
  const classes = children.filter((node) => node.kind === "class").sort(compareSiblingNodes);
  const classNames = new Set(classes.map((node) => node.name));
  const methodsByClass = new Map();
  const freeFunctions = [];
  const rest = [];

  for (const node of children) {
    if (node.kind === "class") continue;
    if (node.kind === "method" && node.metadata?.ownerClass && classNames.has(node.metadata.ownerClass)) {
      if (!methodsByClass.has(node.metadata.ownerClass)) methodsByClass.set(node.metadata.ownerClass, []);
      methodsByClass.get(node.metadata.ownerClass).push(node);
    } else if (node.kind === "function") {
      freeFunctions.push(node);
    } else {
      rest.push(node);
    }
  }

  const ordered = [];
  for (const classNode of classes) {
    ordered.push(classNode);
    ordered.push(...(methodsByClass.get(classNode.name) || []).sort(compareSiblingNodes));
  }
  ordered.push(...freeFunctions.sort(compareSiblingNodes));
  ordered.push(...rest.sort(compareSiblingNodes));
  return ordered.map((node) => node.id);
}

function compareSiblingNodes(a, b) {
  const priority = { folder: 0, module: 1, class: 2, method: 3, function: 4, import: 5, project: 6 };
  const priorityDiff = (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9);
  if (priorityDiff) return priorityDiff;
  const lineDiff = (a.metadata?.line || 0) - (b.metadata?.line || 0);
  if (lineDiff) return lineDiff;
  return listLabel(a).localeCompare(listLabel(b), undefined, { sensitivity: "base" });
}

function listLabel(node) {
  if (node.kind === "folder" && node.metadata?.relpath === ".") return "./";
  return node.metadata?.relpath || node.name || node.id;
}

function nodeSearchText(node) {
  return `${node.name} ${node.kind} ${node.metadata?.relpath || ""} ${node.metadata?.signature || ""}`.toLowerCase();
}

function renderNodes() {
  const visible = visibleNodeIds();
  const selectedNeighbors = relatedIds(state.selectedId);
  const mockNodeIds = new Set(state.mock?.steps.map((step) => step.nodeId) || []);
  const readyMockNodeIds = new Set((state.mock?.steps || []).slice(0, (state.mock?.step ?? -1) + 1).map((step) => step.nodeId));
  const currentMockNodeId = state.mock?.steps?.[state.mock.step]?.nodeId;
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
      readyMockNodeIds.has(n.id) ? "mock-ready" : "",
      currentMockNodeId === n.id ? "mock-current" : "",
      state.selectedId && !selectedNeighbors.has(n.id) && !mockNodeIds.has(n.id) ? "dim" : "",
      !visible.has(n.id) ? "hidden" : "",
    ].join(" ");
    el.dataset.id = n.id;
    el.style.left = `${screenX(pos.x)}px`;
    el.style.top = `${screenY(pos.y)}px`;
    // Scale is fine on its own (no 3D), but translateZ is dropped: combined
    // with the parent perspective(1000px) it shifts the visual box away
    // from the hit area, so cursor and node fall out of sync. Stacking
    // order is now driven by z-index (set inline here).
    el.style.transform = `scale(${state.zoom})`;
    el.style.zIndex = String(depthFor(n.kind) * 10);
    const collapseButton = isCollapsibleNode(n)
      ? `<button class="node-collapse-toggle" data-collapse="${escapeHtml(n.id)}" title="${state.collapsed.has(n.id) ? "Expand" : "Collapse"}">${state.collapsed.has(n.id) ? "+" : "-"}</button>`
      : "";
    el.innerHTML = `
      <span class="node-orb kind-${n.kind}"></span>
      <span><strong>${escapeHtml(n.name)}</strong><small>${escapeHtml(n.kind)}</small></span>
      ${collapseButton}
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
  renderMockFlowEdges();
}

function renderMockFlowEdges() {
  if (!state.mock?.steps?.length) return;
  for (let index = 1; index < state.mock.steps.length; index += 1) {
    const source = centerOf(state.mock.steps[index - 1].nodeId);
    const target = centerOf(state.mock.steps[index].nodeId);
    if (!source || !target) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midX = (source.x + target.x) / 2;
    path.setAttribute("d", `M ${source.x} ${source.y} C ${midX} ${source.y}, ${midX} ${target.y}, ${target.x} ${target.y}`);
    path.setAttribute("class", `edge mock-virtual ${index - 1 <= state.mock.step ? "mock-flow" : "mock-pending"}`);
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
  els.outgoing.innerHTML = relationRows(state.graph.edges.filter((e) => e.source === selected.id && isEdgeKindVisible(e)), "target");
  els.incoming.innerHTML = relationRows(state.graph.edges.filter((e) => e.target === selected.id && isEdgeKindVisible(e)), "source");
  els.mockButton.disabled = !isMockableNode(selected);
  els.mockButton.title = isMockableNode(selected) ? "Build a Python mock input form" : "Quick Mock supports Python functions and classes only";
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
  const selected = findNode(selectedId);
  if (!state.mock || state.mock.nodeId !== selectedId) {
    const message = isMockableNode(selected)
      ? "Build a form for this Python target's direct inputs."
      : "Quick Mock is available for Python classes, methods, and functions only.";
    els.mockBody.innerHTML = `<div class="mock-summary">${message}</div>`;
    return;
  }
  const steps = state.mock.steps
    .map((step, index) => {
      const fields = hasMockFields(step) ? renderMockFields(step) : `<div class="mock-fill">No parameters required.</div>`;
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
  const ownerFields = (step.ownerParams || []).flatMap(flattenParamSpec);
  const targetFields = (step.params || []).flatMap(flattenParamSpec);
  const dependencies = [...(step.dependencies || []), ...(step.ownerDependencies || [])];
  return `
    <div class="mock-form">
      ${(step.requires || []).map(renderMockRequirement).join("")}
      ${dependencies.map(renderMockDependency).join("")}
      ${ownerFields.length ? `<div class="mock-fill">self: ${escapeHtml(step.node.metadata.ownerClass)}</div>${renderMockInputs(ownerFields, "owner")}` : ""}
      ${targetFields.length ? renderMockInputs(targetFields, "target") : ""}
    </div>
  `;
}

function renderMockDependency(param) {
  const ready = Boolean(state.mock?.prepared?.[param.type]);
  return `<div class="mock-fill">${escapeHtml(param.name)}: ${escapeHtml(param.type)} ${ready ? "ready" : "from previous step"}</div>`;
}

function renderMockRequirement(type) {
  const ready = Boolean(state.mock?.prepared?.[type]);
  return `<div class="mock-fill">self: ${escapeHtml(type)} ${ready ? "ready" : "from previous step"}</div>`;
}

function renderMockInputs(fields, scope) {
  return fields
    .map((param) => {
      const path = param.path || param.name;
      const value = paramValuesForScope(scope)[path] ?? defaultValueFor(param.name, param.type);
      return `
        <label>
          <span>${escapeHtml(path)}${param.type ? `: ${escapeHtml(param.type)}` : ""}</span>
          <input data-mock-scope="${scope}" data-mock-param="${escapeHtml(path)}" value="${escapeHtml(value)}" />
        </label>
      `;
    })
    .join("");
}

function paramValuesForScope(scope) {
  if (!state.mock) return {};
  const step = state.mock.steps[state.mock.step];
  if (!step) return {};
  return scope === "owner" ? step.ownerValues : step.values;
}

function hasMockFields(step) {
  return Boolean(
    (step.params || []).flatMap(flattenParamSpec).length ||
    (step.ownerParams || []).flatMap(flattenParamSpec).length ||
    (step.dependencies || []).length ||
    (step.ownerDependencies || []).length
  );
}

function updateRenderScope() {
  const neighbors = relatedIds(state.selectedId);
  const mockNodeIds = new Set(state.mock?.steps.map((step) => step.nodeId) || []);
  const visible = visibleNodeIds();
  const kindScore = { project: 70, folder: 60, module: 50, class: 40, method: 30, function: 20, import: 10 };
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
  if (!isMockableNode(selected)) return null;
  const steps = [];
  const seen = new Set();
  for (const param of mockOwnerParamsFor(selected)) {
    collectDependencySteps(param, steps, seen);
  }
  for (const param of mockParamsFor(selected)) {
    collectDependencySteps(param, steps, seen);
  }

  const targetNode = selected.metadata?.ownerClass ? findClassNode(selected.metadata.ownerClass) || selected : selected;
  const targetIsMethodOwner = selected.kind === "method" && targetNode?.kind === "class";
  if (targetIsMethodOwner) {
    const ownerConstructorParams = mockParamsFor(targetNode);
    steps.push({
      kind: "object",
      className: targetNode.name,
      nodeId: targetNode.id,
      targetNodeId: selected.id,
      edgeId: null,
      node: targetNode,
      title: `Prepare ${targetNode.name}`,
      detail: `Fill constructor inputs for ${targetNode.name}.`,
      params: primitiveParamsFor(ownerConstructorParams),
      dependencies: dependencyParamsFor(ownerConstructorParams),
      values: {},
      result: null,
    });
    steps.push({
      kind: "target",
      nodeId: selected.id,
      edgeId: null,
      node: selected,
      title: `Run ${selected.name}`,
      detail: `Call ${targetNode.name}.${selected.name}().`,
      params: primitiveParamsFor(mockParamsFor(selected)),
      ownerParams: primitiveParamsFor(mockOwnerParamsFor(selected)),
      ownerDependencies: dependencyParamsFor(mockOwnerParamsFor(selected)),
      dependencies: dependencyParamsFor(mockParamsFor(selected)),
      requires: [targetNode.name],
      values: {},
      ownerValues: {},
      result: null,
    });
  } else {
  steps.push({
    kind: "target",
    nodeId: targetNode.id,
    targetNodeId: selected.id,
    edgeId: null,
    node: targetIsMethodOwner ? targetNode : selected,
    sourceNode: selected,
    title: targetIsMethodOwner ? `Prepare ${targetNode.name}` : `Mock target: ${selected.name}`,
    detail: targetIsMethodOwner ? `Instantiate ${targetNode.name}.` : mockDetailFor(selected, null),
    params: primitiveParamsFor(targetIsMethodOwner ? mockParamsFor(targetNode) : mockParamsFor(selected)),
    ownerParams: primitiveParamsFor(mockOwnerParamsFor(selected)),
    ownerDependencies: dependencyParamsFor(mockOwnerParamsFor(selected)),
    dependencies: dependencyParamsFor(targetIsMethodOwner ? mockParamsFor(targetNode) : mockParamsFor(selected)),
    values: {},
    ownerValues: {},
    result: null,
  });
  }

  return {
    nodeId,
    step: 0,
    steps,
    prepared: {},
    summary: `Prepare dependencies for ${selected.name} from the bottom up. Use Next to move through each object in the data flow.`,
  };
}

function isEdgeKindVisible(edge) {
  const source = findNode(edge.source);
  const target = findNode(edge.target);
  return Boolean(source && target && isNodeKindVisible(source) && isNodeKindVisible(target));
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
  if (node.kind === "class") return "Instantiate this Python class with constructor inputs.";
  if (node.kind === "method") return `Instantiate ${node.metadata.ownerClass}, then call this method.`;
  return "Call this Python function with direct inputs.";
}

function mockParamsFor(node) {
  if (!node) return [];
  const params = node.metadata?.params || extractParams(node.metadata?.signature || "");
  return params.filter(isUserParam).map((param) => ({ ...param, type: normalizeType(param.type) }));
}

function mockOwnerParamsFor(node) {
  if (!node?.metadata?.isMethod) return [];
  return (node.metadata.ownerParams || []).filter(isUserParam).map((param) => ({ ...param, type: normalizeType(param.type) }));
}

function isUserParam(param) {
  return param?.name && !["self", "cls"].includes(param.name);
}

function collectDependencySteps(param, steps, seen) {
  const type = normalizeType(param.type);
  const classNode = findClassNode(type);
  if (!classNode || isPrimitiveType(type) || seen.has(type)) return;
  seen.add(type);
  const constructorParams = mockParamsFor(classNode);
  for (const child of constructorParams) {
    collectDependencySteps(child, steps, seen);
  }
  steps.push({
    kind: "object",
    className: type,
    nodeId: classNode.id,
    node: classNode,
    title: `Prepare ${type}`,
    detail: `Fill constructor inputs for ${type}.`,
    params: primitiveParamsFor(constructorParams),
    dependencies: dependencyParamsFor(constructorParams),
    values: {},
    result: null,
  });
}

function flattenParamSpec(param) {
  return [param];
}

function primitiveParamsFor(params) {
  return params.filter((param) => !findClassNode(normalizeType(param.type)) || isPrimitiveType(param.type));
}

function dependencyParamsFor(params) {
  return params
    .map((param) => ({ ...param, type: normalizeType(param.type), classNode: findClassNode(normalizeType(param.type)) }))
    .filter((param) => param.classNode && !isPrimitiveType(param.type));
}

function findClassNode(type) {
  if (!type || !state.graph) return null;
  return state.graph.nodes.find((node) => node.kind === "class" && node.name === type);
}

function isMockableNode(node) {
  return Boolean(node && ["function", "method", "class"].includes(node.kind) && node.metadata?.relpath?.endsWith(".py"));
}

function normalizeType(type) {
  return String(type || "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/^Optional\[(.*)\]$/, "$1")
    .replace(/^typing\.Optional\[(.*)\]$/, "$1")
    .replace(/\s*\|\s*None$/, "")
    .trim();
}

function isPrimitiveType(type) {
  const normalized = normalizeType(type).toLowerCase();
  if (!normalized) return true;
  return ["str", "int", "float", "bool", "bytes", "dict", "list", "tuple", "set", "any"].includes(normalized);
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
    nearbyNodes: state.graph.nodes.filter((n) => neighborhood.has(n.id) && isNodeKindVisible(n)),
    relationships: state.graph.edges.filter((e) => neighborhood.has(e.source) && neighborhood.has(e.target) && isEdgeKindVisible(e)),
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
  return { project: 64, folder: 54, module: 44, class: 34, method: 24, function: 14, import: 6 }[kind] || 0;
}

function selectNode(id) {
  if (state.selectedId !== id) state.mock = null;
  state.selectedId = id;
  const node = findNode(id);
  updatePathInputFromNode(node);

  // Clicking a graph node only FOCUSES it. Expanding/collapsing is controlled
  // exclusively by the +/- button (see toggleCollapse). We still auto-expand
  // ancestor containers so the focused node is actually visible.
  if (expandParents(node)) {
    layoutGraph();
  }
  render();
}

function updatePathInputFromNode(node) {
  if (!node || !["project", "folder"].includes(node.kind)) return;
  const selectedPath = node.metadata?.path || (node.kind === "project" ? state.graph?.root : "");
  if (selectedPath) {
    els.pathInput.value = selectedPath;
  }
}

function expandParents(node) {
  if (!node) return false;
  if (node.kind === "folder") return false;
  let changed = false;

  const relpath = node.metadata?.relpath;
  if (relpath) {
    // If it's a class/function/import, check containing file
    if (node.kind !== "module" && node.kind !== "folder") {
      const moduleId = `file:${relpath}`;
      if (state.collapsed.has(moduleId)) {
        state.collapsed.delete(moduleId);
        changed = true;
      }
    }
    if (node.kind === "method" && node.metadata?.ownerClass) {
      const classId = `class:${relpath}:${node.metadata.ownerClass}`;
      if (state.collapsed.has(classId)) {
        state.collapsed.delete(classId);
        changed = true;
      }
    }
    // Check containing folder
    const parts = relpath.split('/');
    const folderId = parts.length > 1 ? `folder:${parts[0]}` : "folder:.";
    if (folderId !== node.id && state.collapsed.has(folderId)) {
      state.collapsed.delete(folderId);
      changed = true;
    }
  }
  if (changed) {
    saveCollapsedConfig();
  }
  return changed;
}

function toggleModule(id, skipRender = false) {
  if (state.collapsed.has(id)) {
    state.collapsed.delete(id);
  } else {
    state.collapsed.add(id);
  }
  saveCollapsedConfig();
  if (!skipRender) {
    layoutGraph();
    render();
  }
}

async function saveCollapsedConfig() {
  if (!window.pywebview?.api || !state.graph) return;
  const projectPath = state.graph.root;
  const collapsedArray = Array.from(state.collapsed);

  if (!state.loadedConfig) state.loadedConfig = {};
  if (!state.loadedConfig.collapsed_by_project) state.loadedConfig.collapsed_by_project = {};
  state.loadedConfig.collapsed_by_project[projectPath] = collapsedArray;

  await window.pywebview.api.update_config({
    collapsed_by_project: state.loadedConfig.collapsed_by_project
  });
}

function applyKindFilterConfig() {
  const savedFilters = state.loadedConfig?.kind_filters;
  if (savedFilters && typeof savedFilters === "object") {
    for (const kind of Object.keys(state.kindFilters)) {
      if (typeof savedFilters[kind] === "boolean") {
        state.kindFilters[kind] = savedFilters[kind];
      }
    }
  }
  els.kindFilters.forEach((input) => {
    input.checked = state.kindFilters[input.dataset.kindFilter] !== false;
  });
}

async function saveKindFilterConfig() {
  if (!window.pywebview?.api) return;
  if (!state.loadedConfig) state.loadedConfig = {};
  state.loadedConfig.kind_filters = { ...state.kindFilters };
  try {
    await window.pywebview.api.update_config({
      kind_filters: state.loadedConfig.kind_filters,
    });
  } catch {
    // The filter should still update immediately even if config persistence fails.
  }
}

function startMockTrace() {
  if (!state.selectedId || !state.graph) return;
  state.mock = buildMockPlan(state.selectedId);
  if (!state.mock) {
    const selected = findNode(state.selectedId);
    state.mock = {
      nodeId: state.selectedId,
      step: 0,
      steps: [],
      summary: `${selected?.name || "This node"} is not a Python class, method, or function.`,
    };
  }
  render();
}

function stepMock(delta) {
  if (!state.mock) return;
  state.mock.step = Math.max(0, Math.min(state.mock.steps.length - 1, state.mock.step + delta));
  render();
}

async function runMockStep(index) {
  if (!state.mock) return;
  const step = state.mock.steps[index];
  if (!step?.node) {
    step.result = { ok: false, text: "This step is not available." };
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
  step.ownerValues = {};
  inputs.forEach((input) => {
    const param = input.dataset.mockParam;
    if (input.dataset.mockScope === "owner") {
      step.ownerValues[param] = input.value;
    } else {
      step.values[param] = input.value;
    }
  });

  const missing = missingPreparedDependencies(step);
  if (missing.length) {
    step.result = { ok: false, text: `Prepare first: ${missing.join(", ")}` };
    render();
    return;
  }

  if (step.kind === "object") {
    state.mock.prepared[step.className] = materializePreparedObject(step);
    step.result = { ok: true, text: `${step.className} prepared.` };
    render();
    return;
  }

  if (!window.pywebview?.api) return;
  if (!["function", "method", "class"].includes(step.node.kind)) {
    step.result = { ok: false, text: "This step is not directly executable. Select a Python class, method, or top-level function." };
    render();
    return;
  }

  const args = materializeArgs(step.params, step.values, step.dependencies || []);
  const ownerArgs = materializeArgs(step.ownerParams || [], step.ownerValues, step.ownerDependencies || []);
  step.result = { ok: true, text: "Running..." };
  render();
  const result = await window.pywebview.api.run_python_mock({
    projectRoot: state.graph.root,
    relpath: step.node.metadata.relpath,
    symbolName: step.node.name,
    kind: step.node.kind,
    ownerClass: step.node.metadata?.ownerClass || "",
    args,
    ownerArgs,
  });
  step.result = result.ok
    ? { ok: true, text: `${result.resultType}: ${result.result}` }
    : { ok: false, text: result.error || "Execution failed." };
  render();
}

function materializeArgs(params, values, dependencies = []) {
  const args = {};
  for (const param of params || []) {
    args[param.name] = {
      value: materializeParamValue(param, values),
      type: param.type,
    };
  }
  for (const param of dependencies) {
    args[param.name] = {
      value: JSON.stringify(state.mock?.prepared?.[param.type] || {}),
      type: param.type,
    };
  }
  return args;
}

function materializeParamValue(param, values) {
  const path = param.path || param.name;
  return values[path] ?? defaultValueFor(param.name, param.type);
}

function materializePreparedObject(step) {
  const result = {};
  for (const param of step.params || []) {
    result[param.name] = materializeParamValue(param, step.values);
  }
  for (const param of step.dependencies || []) {
    result[param.name] = state.mock?.prepared?.[param.type] || {};
  }
  return result;
}

function missingPreparedDependencies(step) {
  const dependencyTypes = [...(step.dependencies || []), ...(step.ownerDependencies || [])].map((param) => param.type);
  return [...dependencyTypes, ...(step.requires || [])]
    .filter((type) => !state.mock?.prepared?.[type]);
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
      // First, fetch config if we haven't already
      if (!state.loadedConfig) {
        state.loadedConfig = await window.pywebview.api.get_config();
        applyKindFilterConfig();
        // Apply width configs
        if (state.loadedConfig.left_width) {
          document.documentElement.style.setProperty("--left-width", `${state.loadedConfig.left_width}px`);
        }
        if (state.loadedConfig.right_width) {
          document.documentElement.style.setProperty("--right-width", `${state.loadedConfig.right_width}px`);
        }
      }

      const result = await window.pywebview.api.scan_project(path);
      if (!result.ok) throw new Error(result.error);

      // Sync last project to loadedConfig
      state.loadedConfig.last_project = result.graph.root;

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
applyKindFilterConfig();
els.kindFilters.forEach((input) => {
  input.addEventListener("change", async () => {
    state.kindFilters[input.dataset.kindFilter] = input.checked;
    await saveKindFilterConfig();
    if (state.selectedId) {
      const selected = findNode(state.selectedId);
      if (selected && !isNodeKindVisible(selected)) {
        state.selectedId = null;
        state.mock = null;
      }
    }
    if (!state.graph) return;
    layoutGraph();
    render();
  });
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
  if (event.target.closest("[data-collapse]")) return;
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
  if (state.resizing) {
    saveLayoutConfig();
  }
  state.dragging = null;
  state.panning = null;
  state.resizing = null;
  els.graph.classList.remove("panning");
  els.leftResizer.classList.remove("active");
  els.rightResizer.classList.remove("active");
});

async function saveLayoutConfig() {
  if (!window.pywebview?.api) return;
  const leftWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--left-width"));
  const rightWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--right-width"));

  if (!state.loadedConfig) state.loadedConfig = {};
  state.loadedConfig.left_width = leftWidth;
  state.loadedConfig.right_width = rightWidth;

  await window.pywebview.api.update_config({
    left_width: leftWidth,
    right_width: rightWidth
  });
}

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
