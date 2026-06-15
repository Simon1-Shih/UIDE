import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const featurePath = resolve(__dirname, "features/quick-mock.feature");

const world = {
  browser: null,
  page: null,
  dllPath: "",
  backendProjectRoot: "",
  backendResult: null,
};

const steps = [
  [/^Given a scanned graph with MSRWattageReader and its (get_wattage|cpuid) method$/, async () => {
    await world.browser?.close();
    world.browser = await chromium.launch();
    world.page = await world.browser.newPage();
    world.page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        console.error(`[browser:${message.type()}] ${message.text()}`);
      }
    });
    world.page.on("pageerror", (error) => {
      console.error(`[browser:pageerror] ${error.message}`);
    });
    await world.page.addInitScript((graph) => {
      window.__mockCalls = [];
      window.pywebview = {
        api: {
          get_config: async () => ({ kind_filters: { import: true, class: true, function: true, method: true } }),
          scan_project: async () => ({ ok: true, graph }),
          update_config: async () => ({ ok: true }),
          choose_folder: async () => ({ ok: true, graph }),
          run_python_mock: async (request) => {
            window.__mockCalls.push(request);
            if (request.kind === "class" && request.symbolName === "MSRWattageReader") {
              return { ok: true, resultType: "MSRWattageReader", result: "<MSRWattageReader>" };
            }
            if (request.kind === "method" && request.symbolName === "get_wattage") {
              return { ok: true, resultType: "float", result: "42.5" };
            }
            if (request.kind === "method" && request.symbolName === "cpuid") {
              return { ok: true, resultType: "tuple", result: "(0, 0, 0, 0)" };
            }
            return { ok: false, error: `Unexpected mock request: ${request.kind} ${request.symbolName}` };
          },
        },
      };
    }, quickMockGraph());

    await world.page.goto(pathToFileURL(resolve(repoRoot, "web/index.html")).href);
    await world.page.evaluate(() => window.dispatchEvent(new Event("pywebviewready")));
    await world.page.locator(".node-row", { hasText: "wattage_reader.py" }).first().waitFor();
  }],
  [/^When I trace the get_wattage method$/, async () => {
    await traceMethod("get_wattage");
  }],
  [/^When I trace the cpuid method$/, async () => {
    await traceMethod("cpuid");
  }],
  [/^And I choose int for index and fill "(.+)"$/, async (index) => {
    await world.page.locator('[data-mock-type-param="index"]').selectOption("int");
    await world.page.waitForFunction(() => document.querySelector('[data-mock-param="index"]')?.tagName === "INPUT");
    await world.page.locator('[data-mock-param="index"]').fill(index);
  }],
  [/^And I choose bool for index$/, async () => {
    await world.page.locator('[data-mock-type-param="index"]').selectOption("bool");
  }],
  [/^Then index value uses a bool dropdown$/, async () => {
    const tagName = await world.page.locator('[data-mock-param="index"]').evaluate((element) => element.tagName);
    assert.equal(tagName, "SELECT");
  }],
  [/^Then the backend receives a method mock request for cpuid with index "(.+)" as int$/, async (index) => {
    const request = await mockCall(1);
    assert.equal(request.kind, "method");
    assert.equal(request.symbolName, "cpuid");
    assert.equal(request.args.index.value, index);
    assert.equal(request.args.index.type, "int");
  }],
  [/^When I run the backend mock with index "(.+)" as int$/, async (index) => {
    const script = [
      "from app import Api",
      "import json",
      "request = {",
      `  'projectRoot': ${JSON.stringify(world.backendProjectRoot)},`,
      "  'relpath': 'backend/mock_target.py',",
      "  'symbolName': 'accepts_index',",
      "  'kind': 'function',",
      `  'args': {'index': {'value': ${JSON.stringify(index)}, 'type': 'int'}},`,
      "  'ownerArgs': {},",
      "}",
      "print(json.dumps(Api().run_python_mock(request), ensure_ascii=False))",
    ].join("\n");
    const result = spawnSync("python", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    world.backendResult = JSON.parse(result.stdout);
  }],
  [/^When I run the backend mock with index "(.+)"$/, async (index) => {
    const script = [
      "from app import Api",
      "import json",
      "request = {",
      `  'projectRoot': ${JSON.stringify(world.backendProjectRoot)},`,
      "  'relpath': 'backend/mock_target.py',",
      "  'symbolName': 'accepts_index',",
      "  'kind': 'function',",
      `  'args': {'index': {'value': ${JSON.stringify(index)}, 'type': ''}},`,
      "  'ownerArgs': {},",
      "}",
      "print(json.dumps(Api().run_python_mock(request), ensure_ascii=False))",
    ].join("\n");
    const result = spawnSync("python", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    world.backendResult = JSON.parse(result.stdout);
  }],
];

const moreSteps = [
  [/^Then the mock panel asks me to prepare MSRWattageReader with dll_path$/, async () => {
    await expectText("#mockBody", "Prepare MSRWattageReader");
    await expectText("#mockBody", "dll_path");
    const value = await world.page.locator('[data-mock-param="dll_path"]').inputValue();
    assert.equal(value, "");
  }],
  [/^When I fill dll_path with "(.+)"$/, async (dllPath) => {
    world.dllPath = dllPath;
    await world.page.locator('[data-mock-param="dll_path"]').fill(dllPath);
  }],
  [/^And I run the prepare step$/, async () => {
    await world.page.locator("#mockNextButton").click();
    await expectText("#mockBody", "MSRWattageReader prepared.");
  }],
  [/^Then the backend receives a class mock request for MSRWattageReader with dll_path "(.+)"$/, async (dllPath) => {
    const request = await mockCall(0);
    assert.equal(request.kind, "class");
    assert.equal(request.symbolName, "MSRWattageReader");
    assert.equal(request.args.dll_path.value, dllPath);
  }],
  [/^(?:When|And) I run the method step$/, async () => {
    await world.page.locator("#mockNextButton").click();
  }],
  [/^Then the backend receives a method mock request for get_wattage using MSRWattageReader with dll_path "(.+)"$/, async (dllPath) => {
    const request = await mockCall(1);
    assert.equal(request.kind, "method");
    assert.equal(request.symbolName, "get_wattage");
    assert.equal(request.ownerClass, "MSRWattageReader");
    assert.equal(request.ownerArgs.dll_path.value, dllPath);
  }],
  [/^Given a backend mock target with an untyped index parameter$/, async () => {
    world.backendProjectRoot = mkdtempSync(resolve(tmpdir(), "uide-bdd-"));
    mkdirSync(resolve(world.backendProjectRoot, "backend"), { recursive: true });
    writeFileSync(
      resolve(world.backendProjectRoot, "backend", "mock_target.py"),
      [
        "def accepts_index(index):",
        "    return f'{type(index).__name__}:{index}'",
        "",
      ].join("\n"),
      "utf8"
    );
  }],
  [/^When I run the backend mock with index "(.+)"$/, async (index) => {
    const script = [
      "from app import Api",
      "import json",
      "request = {",
      `  'projectRoot': ${JSON.stringify(world.backendProjectRoot)},`,
      "  'relpath': 'backend/mock_target.py',",
      "  'symbolName': 'accepts_index',",
      "  'kind': 'function',",
      `  'args': {'index': {'value': ${JSON.stringify(index)}, 'type': ''}},`,
      "  'ownerArgs': {},",
      "}",
      "print(json.dumps(Api().run_python_mock(request), ensure_ascii=False))",
    ].join("\n");
    const result = spawnSync("python", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    world.backendResult = JSON.parse(result.stdout);
  }],
  [/^Then the Python target receives integer index 0$/, async () => {
    assert.equal(world.backendResult.ok, true, world.backendResult.error);
    assert.equal(world.backendResult.result, "'int:0'");
  }],
  [/^Given a backend mock target that imports a sibling module relatively$/, async () => {
    world.backendProjectRoot = mkdtempSync(resolve(tmpdir(), "uide-bdd-"));
    mkdirSync(resolve(world.backendProjectRoot, "backend"), { recursive: true });
    writeFileSync(resolve(world.backendProjectRoot, "backend", "__init__.py"), "", "utf8");
    writeFileSync(resolve(world.backendProjectRoot, "backend", "helper.py"), "VALUE = 'relative-ok'\n", "utf8");
    writeFileSync(
      resolve(world.backendProjectRoot, "backend", "mock_target.py"),
      [
        "from .helper import VALUE",
        "",
        "def read_value():",
        "    return VALUE",
        "",
      ].join("\n"),
      "utf8"
    );
  }],
  [/^When I run the backend mock target$/, async () => {
    const script = [
      "from app import Api",
      "import json",
      "request = {",
      `  'projectRoot': ${JSON.stringify(world.backendProjectRoot)},`,
      "  'relpath': 'backend/mock_target.py',",
      "  'symbolName': 'read_value',",
      "  'kind': 'function',",
      "  'args': {},",
      "  'ownerArgs': {},",
      "}",
      "print(json.dumps(Api().run_python_mock(request), ensure_ascii=False))",
    ].join("\n");
    const result = spawnSync("python", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    world.backendResult = JSON.parse(result.stdout);
  }],
  [/^Then the Python target returns the relative import value$/, async () => {
    assert.equal(world.backendResult.ok, true, world.backendResult.error);
    assert.equal(world.backendResult.result, "'relative-ok'");
  }],
];

steps.push(...moreSteps);

async function traceMethod(methodName) {
  await world.page.locator("#searchInput").fill(methodName);
  await world.page.locator(".node-row", { hasText: methodName }).click();
  await world.page.waitForFunction(() => !document.querySelector("#mockButton")?.disabled);
  await world.page.locator("#mockButton").click();
  await world.page.waitForTimeout(100);
  const mockText = await world.page.locator("#mockBody").innerText();
  if (mockText.includes("Build a form")) {
    const buttonState = await world.page.locator("#mockButton").evaluate((button) => ({
      disabled: button.disabled,
      text: button.textContent,
      rect: button.getBoundingClientRect().toJSON(),
    }));
    throw new Error(`Trace click did not update Quick Mock.\nButton: ${JSON.stringify(buttonState)}`);
  }
}

try {
  await runFeature(featurePath);
  console.log("BDD passed: quick-mock.feature");
} finally {
  await world.browser?.close();
}

async function runFeature(path) {
  const content = await readFile(path, "utf8");
  const scenarioLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => /^(Given|When|Then|And)\s/.test(line));

  for (const line of scenarioLines) {
    const stepText = line.replace(/^(Given|When|Then|And)\s+/, "$1 ");
    const matched = steps.find(([pattern]) => pattern.test(stepText));
    assert.ok(matched, `No step definition for: ${line}`);
    const [, ...args] = stepText.match(matched[0]);
    await matched[1](...args);
  }
}

async function expectText(selector, text) {
  try {
    await world.page.waitForFunction(
      ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text),
      { selector, text },
      { timeout: 5000 }
    );
  } catch (error) {
    const bodyText = await world.page.locator("body").innerText().catch(() => "");
    throw new Error(`Expected ${selector} to contain "${text}".\n\nPage text:\n${bodyText}`);
  }
}

async function mockCall(index) {
  await world.page.waitForFunction((index) => window.__mockCalls.length > index, index);
  return world.page.evaluate((index) => window.__mockCalls[index], index);
}

function quickMockGraph() {
  const relpath = "backend/utils/wattage_reader.py";
  const classId = `class:${relpath}:MSRWattageReader`;
  const methodId = `method:${relpath}:MSRWattageReader.get_wattage`;
  const cpuidMethodId = `method:${relpath}:MSRWattageReader.cpuid`;
  return {
    root: "C:\\Users\\G13DS\\PycharmProjects\\pythonProject\\VGA\\burn",
    stats: { files: 1, nodes: 5, edges: 4 },
    nodes: [
      { id: "project", kind: "project", name: "burn", metadata: {} },
      { id: `file:${relpath}`, kind: "module", name: "wattage_reader.py", metadata: { relpath } },
      {
        id: classId,
        kind: "class",
        name: "MSRWattageReader",
        metadata: {
          relpath,
          line: 10,
          signature: "MSRWattageReader(dll_path = None)",
          params: [
            { name: "self", type: "", default: "", required: true, keywordOnly: false },
            { name: "dll_path", type: "", default: "None", required: false, keywordOnly: false },
          ],
          ownerClass: "",
          ownerParams: [],
          isMethod: false,
        },
      },
      {
        id: methodId,
        kind: "method",
        name: "get_wattage",
        metadata: {
          relpath,
          line: 94,
          signature: "get_wattage(self)",
          params: [{ name: "self", type: "", default: "", required: true, keywordOnly: false }],
          ownerClass: "MSRWattageReader",
          ownerParams: [
            { name: "self", type: "", default: "", required: true, keywordOnly: false },
            { name: "dll_path", type: "", default: "None", required: false, keywordOnly: false },
          ],
          isMethod: true,
        },
      },
      {
        id: cpuidMethodId,
        kind: "method",
        name: "cpuid",
        metadata: {
          relpath,
          line: 73,
          signature: "cpuid(self, index)",
          params: [
            { name: "self", type: "", default: "", required: true, keywordOnly: false },
            { name: "index", type: "", default: "", required: true, keywordOnly: false },
          ],
          ownerClass: "MSRWattageReader",
          ownerParams: [
            { name: "self", type: "", default: "", required: true, keywordOnly: false },
            { name: "dll_path", type: "", default: "None", required: false, keywordOnly: false },
          ],
          isMethod: true,
        },
      },
    ],
    edges: [
      { id: "project->file", source: "project", target: `file:${relpath}`, kind: "contains", label: "contains" },
      { id: "file->class", source: `file:${relpath}`, target: classId, kind: "contains", label: "contains" },
      { id: "class->method", source: classId, target: methodId, kind: "contains", label: "contains" },
      { id: "class->cpuid", source: classId, target: cpuidMethodId, kind: "contains", label: "contains" },
    ],
  };
}
