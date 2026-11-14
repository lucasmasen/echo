// "Links never spend": no address Echo hands out or reads can start a paid request without a person's click or key.
//   node scripts/check-links.mjs
// Paid requests are POSTs to /api/analyze (Claude + Tavily), /api/claims (fetches another site), /api/compare (the
// origin layer's token comparison: two Claude calls, off unless ECHO_ORIGIN_LAYER=1) and /api/copy-hunt
// (Tavily). Links are every way into the app with an address: ?claim=, ?slot=, ?trace=, ?urls= (fills the Check these
// sources panel, with ?claim= its sentence), any other parameter, the browser extension's menu links and toolbar
// button, and the bookmarklet. No network, no spend.
//
// Part 1, static, over the TypeScript syntax of src/app (outside api), src/lib/echo/bookmarklet.ts and extension/:
//   - every fetch is found; a POST to a paid route is traced back through every caller in its file (named functions,
//     ref.current functions, props passed to a component in the same file, promise callbacks and timers). Each path
//     must end at a person's event on a page element (onClick, onSubmit, onChange, a key) or a keydown/click listener;
//     a path that ends at a mount or update effect, a timer, module code, onToggle/onFocus/onLoad, or anything the check
//     cannot follow fails. A fetch whose address or method the check cannot read must be a GET;
//   - a paid route's address may appear only as the first argument of fetch (no href, src, form action, sendBeacon,
//     XMLHttpRequest, EventSource), and programmatic .click()/.submit()/.requestSubmit()/.dispatchEvent() is allowed
//     only on the two file pickers and the download link;
//   - the address bar is read in one place (the workbench's mount effect; no useSearchParams, no page searchParams),
//     only for slot, trace, claim and urls, and nothing that effect calls can reach a paid fetch; the extension and the
//     bookmarklet make no request at all;
//   - no page or component outside /api imports the pipeline, copy hunt, scout or budget modules or reads a provider
//     key, so a GET of a page (a link, a crawler, a prefetch) cannot spend on the server;
//   - on the server, only POST handlers spend: /api/analyze's GET never calls analyzeClaim, /api/claims and
//     /api/copy-hunt export no GET.
// Part 2, a harness: the real workbench runs under a stand-in React (state, refs, memos, effects in order, fake timers,
// no DOM) with fetch recorded. Each link (hand-written, from the extension's link builder, from the bookmarklet) is
// opened with keys ready, presenter-locked, keys missing and the status check failing, every non-user event the app
// listens for is fired, and two minutes of timers run: no paid request may be sent, and the link must do what it says
// (fill the claim box or the sources panel, open the saved run, or nothing). Then the same harness presses the buttons, and the paid
// requests must appear: proof the harness would see one. Odd but valid trace files (a rehearsal, no search audit, a
// failed first search, a cost receipt; zero pages, which the import refuses) are opened and presented slide by slide.
// Part 3, offline links: public/sw.js runs in a sandbox (fake caches and network) through install, upgrade, a failed
// install and offline navigations, and its precache lists are tied to the routes, the bundled traces and git history.
// Then review checks: the round-5 UI review's five bugs (fixed 11/13) and round 8's (page breakdown, slide 4 groups,
// a failed run's spend, /anywhere offline, a $0 or sub-cent failed run, readiness without an app shell; A, C and D
// fixed on main 11/13) are plain checks. One expected failure remains, B (the offline cache only grows): its fix was
// deferred by the coordinator until after the freeze; it logs without failing.
//
// Limits: the static part follows calls within one file (a paid callback handed to a component in another file is not
// followed and fails), assumes no eval or computed property calls, and treats every reference of a name in its scope
// as a call path (shadowing only adds paths). onToggle is never fired by the harness (the static part refuses it). The
// harness renders no DOM: refs stay empty, CSS and layout do not run, and a browser extension or devtools can of course
// send anything. Server routes are checked for what they export, not run (check:readiness and check:claims run them).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (file) => path.relative(root, file);
const PAID_ROUTES = ["/api/analyze", "/api/claims", "/api/copy-hunt", "/api/compare"];
const PAID_PATH = /^\/api\/(?:analyze|claims|copy-hunt|compare)(?=$|[?#/])/;
const failures = [];
const fail = (message) => failures.push(message);

function filesIn(dir, pattern) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(full, pattern);
    return pattern.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}
const appDir = path.join(root, "src", "app");
const clientFiles = [
  ...filesIn(appDir, /\.(?:ts|tsx)$/).filter((file) => !file.startsWith(path.join(appDir, "api") + path.sep)),
  path.join(root, "src", "lib", "echo", "bookmarklet.ts"),
];
const extensionFiles = filesIn(path.join(root, "extension"), /\.js$/);
const EMBED_WORKBENCH = path.join(appDir, "echo-workbench.tsx");
const EMBED_BRIDGE = path.join(appDir, "embed-bridge.ts");
const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); };
const isFunctionLike = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const where = (sf, node) => `${rel(sf.fileName)}:${lineOf(sf, node)}`;

// ---------------------------------------------------------------------------------------------------------------------
// Part 1: static.

/** A literal address ("/api/analyze", `/api/x/${id}`), or null when it is computed. */
function literalAddress(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return `${node.head.text}\${…}`;
  return null;
}

/** The method a fetch's options name: "GET" with no options or no method, null when the check cannot read it. */
function fetchMethod(options) {
  if (!options) return "GET";
  if (!ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "method") return null;
    if (ts.isSpreadAssignment(property)) return null;
    if (ts.isPropertyAssignment(property) && property.name.getText() === "method") return ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : null;
  }
  return "GET";
}

const isFetchCallee = (expression) => (ts.isIdentifier(expression) && expression.text === "fetch")
  || (ts.isPropertyAccessExpression(expression) && expression.name.text === "fetch" && ["window", "globalThis", "self"].includes(expression.expression.getText()));

// The events only a person causes. React's onChange fires for typing or a chosen file, never for a value set in code.
const USER_ATTRIBUTES = new Set(["onClick", "onSubmit", "onChange", "onInput", "onKeyDown", "onKeyUp", "onPointerDown", "onPointerUp", "onMouseDown", "onMouseUp", "onDrop"]);
const USER_LISTENERS = new Set(["click", "submit", "keydown", "keyup", "pointerdown", "pointerup"]);
// Callbacks that run as part of whatever runs the function around them.
const PASS_THROUGH_CALLS = /^(?:.*\.(?:then|catch|finally|map|forEach|filter|find|findIndex|some|every|flatMap|reduce)|(?:window\.)?(?:setTimeout|requestAnimationFrame|queueMicrotask))$/;

/** Steps out of the wrappers a function value can sit in: (fn), a ? fn : b, a && fn, fn as T. */
function valueSite(node) {
  let site = node;
  while (site.parent && (ts.isParenthesizedExpression(site.parent) || ts.isAsExpression(site.parent) || ts.isNonNullExpression(site.parent) || ts.isSatisfiesExpression?.(site.parent)
    || (ts.isConditionalExpression(site.parent) && site.parent.condition !== site)
    || (ts.isBinaryExpression(site.parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(site.parent.operatorToken.kind)))) site = site.parent;
  return site;
}

const enclosingFunction = (node) => { let at = node.parent; while (at && !isFunctionLike(at)) at = at.parent; return at ?? null; };
const nearestScope = (node) => { let at = node.parent; while (at && !ts.isBlock(at) && !ts.isSourceFile(at)) at = at.parent; return at; };
const tagNameOf = (attribute) => attribute.parent.parent.tagName.getText();

/**
 * Every way `node` (a call or a function value) can come to run, as paths of steps. A path ends ok at a person's event,
 * or fails with the reason. `seen` stops at a binding already being followed (a loop adds no new way in).
 */
function waysIn(sf, node, seen = new Set()) {
  const fn = isFunctionLike(node) ? node : enclosingFunction(node);
  if (!fn) return [{ ok: false, steps: [`module code at ${where(sf, node)}`] }];
  if (ts.isFunctionDeclaration(fn)) {
    return fn.name ? followBinding(sf, fn.name.text, nearestScope(fn) ?? sf, fn.name, seen) : [{ ok: false, steps: [`an unnamed function at ${where(sf, fn)}`] }];
  }
  const site = valueSite(fn);
  const parent = site.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === site && ts.isIdentifier(parent.name)) return followBinding(sf, parent.name.text, nearestScope(parent), parent.name, seen);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === site && ts.isPropertyAccessExpression(parent.left)) {
    return followBinding(sf, parent.left.getText(), enclosingFunction(parent)?.body ?? sf, parent.left, seen);
  }
  if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) return viaAttribute(sf, parent.parent, seen);
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(site)) {
    const callee = parent.expression.getText();
    if (/(?:^|\.)addEventListener$/.test(callee)) return viaListener(sf, parent);
    // The one way in that is not a person's event on the page: the side panel's start message to /embed, which
    // useEmbedStart (src/app/embed-bridge.ts) passes on only from an allowlisted chrome-extension origin with the
    // page's one-time nonce, once. Part 2 forges every other kind of message at it and must see no run.
    if (callee === "useEmbedStart" && sf.fileName === EMBED_WORKBENCH) return [{ ok: true, steps: [`useEmbedStart(…) at ${where(sf, parent)}: the extension's start message (allowlisted origin + one-time nonce, once; Part 2 forges the rest)`] }];
    if (PASS_THROUGH_CALLS.test(callee) || (ts.isNewExpression(parent) && callee === "Promise")) return waysIn(sf, parent, seen).map((way) => ({ ...way, steps: [`${callee}(…) at ${where(sf, parent)}`, ...way.steps] }));
    if (/^(?:React\.)?use(?:Layout)?Effect$/.test(callee)) return [{ ok: false, steps: [`${callee} at ${where(sf, parent)}: runs when the component mounts or updates`] }];
    if (/^(?:React\.)?use(?:Callback|Memo)$/.test(callee) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) return followBinding(sf, parent.parent.name.text, nearestScope(parent.parent), parent.parent.name, seen);
    return [{ ok: false, steps: [`passed to ${callee}(…) at ${where(sf, parent)}, which this check does not follow`] }];
  }
  return [{ ok: false, steps: [`a function at ${where(sf, fn)} in a place this check does not follow`] }];
}

function viaListener(sf, call) {
  const event = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : null;
  const step = `${call.expression.getText()}("${event}") at ${where(sf, call)}`;
  return [USER_LISTENERS.has(event) ? { ok: true, steps: [step] } : { ok: false, steps: [`${step}: not an event only a person causes`] }];
}

function viaAttribute(sf, attribute, seen) {
  const name = attribute.name.getText();
  const tag = tagNameOf(attribute);
  const step = `<${tag} ${name}> at ${where(sf, attribute)}`;
  if (/^[a-z]/.test(tag)) return [USER_ATTRIBUTES.has(name) ? { ok: true, steps: [step] } : { ok: false, steps: [`${step}: not an event only a person causes`] }];
  // A prop handed to a component in this file: follow it to where that component calls or attaches it.
  const component = findComponent(sf, tag);
  if (!component) return [{ ok: false, steps: [`${step}: component ${tag} is not in this file, so the check cannot follow the prop`] }];
  const [props] = component.parameters;
  if (props && ts.isObjectBindingPattern(props.name)) {
    const element = props.name.elements.find((entry) => (entry.propertyName ?? entry.name).getText() === name);
    if (!element) return [{ ok: true, steps: [`${step}: ${tag} never reads ${name}`] }];
    return followBinding(sf, element.name.getText(), component.body, element.name, seen).map((way) => ({ ...way, steps: [step, ...way.steps] }));
  }
  if (props && ts.isIdentifier(props.name)) return followBinding(sf, `${props.name.text}.${name}`, component.body, null, seen).map((way) => ({ ...way, steps: [step, ...way.steps] }));
  return [{ ok: true, steps: [`${step}: ${tag} takes no props`] }];
}

function findComponent(sf, name) {
  let found = null;
  walk(sf, (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && isFunctionLike(node.initializer)) found = node.initializer;
  });
  return found;
}

/** Every use of `name` (an identifier or "a.b") in `scope`, followed to how it runs. */
function followBinding(sf, name, scope, declaration, seen) {
  const key = `${sf.fileName}:${name}:${scope.pos}`;
  if (seen.has(key)) return [];
  const nextSeen = new Set(seen).add(key);
  const uses = [];
  walk(scope, (node) => {
    if (node === declaration) return;
    if (name.includes(".") ? ts.isPropertyAccessExpression(node) && node.getText() === name : ts.isIdentifier(node) && node.text === name) {
      // A.b's own identifiers, a property name ({ name: … }, obj.name) and the declaration are not uses.
      if (!name.includes(".") && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) || (ts.isPropertyAssignment(node.parent) && node.parent.name === node) || ts.isBindingElement(node.parent) || (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || (ts.isFunctionDeclaration(node.parent) && node.parent.name === node))) return;
      if (name.includes(".") && ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;
      uses.push(node);
    }
  });
  if (!uses.length) return [{ ok: true, steps: [`${name} is never used`] }];
  return uses.flatMap((use) => {
    const step = `${name} used at ${where(sf, use)}`;
    const parent = use.parent;
    let ways;
    if ((ts.isCallExpression(parent) && parent.expression === use) || (ts.isCallChain?.(parent) && parent.expression === use)) ways = waysIn(sf, parent, nextSeen);
    else if (ts.isCallExpression(parent) && parent.arguments.includes(use) && /(?:^|\.)removeEventListener$/.test(parent.expression.getText())) ways = [{ ok: true, steps: ["removeEventListener (detaches only)"] }];
    else if (ts.isCallExpression(parent) && parent.arguments.includes(use) && /(?:^|\.)addEventListener$/.test(parent.expression.getText())) ways = viaListener(sf, parent);
    else {
      const site = valueSite(use);
      if (ts.isJsxExpression(site.parent) && ts.isJsxAttribute(site.parent.parent)) ways = viaAttribute(sf, site.parent.parent, nextSeen);
      else ways = [{ ok: false, steps: [`it is passed or stored at ${where(sf, use)}, which this check does not follow`] }];
    }
    return ways.map((way) => ({ ...way, steps: [step, ...way.steps] }));
  });
}

const paidCalls = [];
const addressReads = [];
for (const file of [...clientFiles, ...extensionFiles]) {
  const sf = parse(file);
  const isExtension = file.startsWith(path.join(root, "extension"));
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && isFetchCallee(node.expression)) {
      if (isExtension || file.endsWith("bookmarklet.ts")) fail(`${where(sf, node)}: the ${isExtension ? "extension" : "bookmarklet"} makes a request; it must only open a ?claim= link`);
      const address = literalAddress(node.arguments[0]);
      const method = fetchMethod(node.arguments[1]);
      const paidAddress = address !== null && PAID_PATH.test(address);
      if (method === "GET") return;
      if (address === null || method === null) fail(`${where(sf, node)}: a fetch whose ${address === null ? "address" : "method"} this check cannot read must be a plain GET`);
      else if (paidAddress) paidCalls.push({ sf, node, route: address.match(PAID_PATH)[0], method });
      return;
    }
    if (ts.isStringLiteralLike(node) && PAID_PATH.test(node.text) && !(ts.isCallExpression(node.parent) && isFetchCallee(node.parent.expression) && node.parent.arguments[0] === node)) {
      fail(`${where(sf, node)}: "${node.text}" appears outside a fetch's address (a link, form or image could request it)`);
    }
    if (ts.isNewExpression(node) && /^(?:XMLHttpRequest|EventSource|WebSocket)$/.test(node.expression.getText())) fail(`${where(sf, node)}: ${node.expression.getText()} is not allowed in client code`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText().replace(/\?$/, "");
      if (method === "sendBeacon") fail(`${where(sf, node)}: sendBeacon is not allowed in client code`);
      if (["submit", "requestSubmit", "dispatchEvent"].includes(method) || (method === "click" && !node.arguments.length)) {
        // The trace-file and comparison pickers open a file dialog; the download link saves a file. Nothing else.
        if (!(method === "click" && ["traceFileInput.current", "comparisonInput.current", "link"].includes(target))) fail(`${where(sf, node)}: ${target}.${method}() acts for the person; only the two file pickers and the download link may`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "search" && /location$/.test(node.expression.getText())) addressReads.push({ sf, node });
    // A "message" listener (postMessage from another window) only in embed-bridge.ts, whose gate Part 2 tests.
    if (!isExtension && ts.isCallExpression(node) && /(?:^|\.)addEventListener$/.test(node.expression.getText()) && literalAddress(node.arguments[0]) === "message" && file !== EMBED_BRIDGE) fail(`${where(sf, node)}: listens for "message"; only src/app/embed-bridge.ts may, behind its origin and nonce gate`);
    // Next's other ways to read the query: useSearchParams() in a client component, a page's searchParams prop.
    if ((ts.isCallExpression(node) && node.expression.getText() === "useSearchParams") || (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === "searchParams" && ts.isParameter(node.parent.parent))) addressReads.push({ sf, node });
  });
  if (isExtension) {
    const code = fs.readFileSync(file, "utf8");
    if (/XMLHttpRequest|sendBeacon|EventSource|WebSocket|chrome\.scripting|executeScript/.test(code)) fail(`${rel(file)}: the extension may only open tabs`);
  }
}

// The three paid routes are each found, so a broken detector cannot pass by finding nothing.
for (const route of PAID_ROUTES) if (!paidCalls.some((call) => call.route === route)) fail(`no POST to ${route} was found in client code: the detector is broken, or the route is gone (update PAID_ROUTES)`);
const inventory = [];
for (const call of paidCalls) {
  const ways = waysIn(call.sf, call.node);
  const bad = ways.filter((way) => !way.ok);
  for (const way of bad) fail(`${call.method} ${call.route} at ${where(call.sf, call.node)} can run without a person: ${way.steps.join(" ← ")}`);
  const entries = [...new Set(ways.filter((way) => way.ok).map((way) => way.steps[way.steps.length - 1].replace(/ at .*$/, "")))];
  if (!bad.length) inventory.push(`${call.method} ${call.route} (${where(call.sf, call.node)}): only from ${entries.join(", ") || "nowhere (never called)"}`);
}

// The address bar: read in one mount effect, for slot, trace, claim, urls and nums only; nothing it calls reaches a paid fetch.
{
  const reads = addressReads.filter(({ sf }) => sf.fileName.endsWith("echo-workbench.tsx"));
  if (addressReads.length !== 1 || reads.length !== 1) fail(`the address bar's query is read in ${addressReads.length} places (${addressReads.map(({ sf, node }) => where(sf, node)).join(", ")}); expected only the workbench's mount effect`);
  for (const { sf, node } of reads) {
    const effect = enclosingFunction(node);
    const call = effect && valueSite(effect).parent;
    if (!call || !ts.isCallExpression(call) || call.expression.getText() !== "useEffect") { fail(`${where(sf, node)}: the address bar is read outside a mount effect`); continue; }
    const params = new Set();
    walk(effect, (inner) => {
      if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && ["get", "has", "getAll"].includes(inner.expression.name.text) && inner.expression.expression.getText() === "params") params.add(literalAddress(inner.arguments[0]) ?? "?");
    });
    // nums: the answer's citation numbers for ?urls= (Copy link), read by numbersFromParam; it only numbers the chips.
    const allowed = ["claim", "slot", "trace", "urls", "nums"];
    if ([...params].some((param) => !allowed.includes(param))) fail(`${where(sf, node)}: the address bar effect reads ${[...params].join(", ")}; only ${allowed.join(", ")} are reviewed`);
    // Every function the effect can call, followed by name through this file: none may contain a paid fetch.
    const paidFunctions = new Set(paidCalls.filter((paid) => paid.sf === sf).flatMap((paid) => { const chain = []; let at = enclosingFunction(paid.node); while (at) { chain.push(at); at = enclosingFunction(at); } return chain; }));
    const declarations = new Map();
    walk(sf, (inner) => {
      const add = (name, fn) => declarations.set(name, [...(declarations.get(name) ?? []), fn]);
      if (ts.isFunctionDeclaration(inner) && inner.name) add(inner.name.text, inner);
      if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.initializer && isFunctionLike(inner.initializer)) add(inner.name.text, inner.initializer);
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(inner.left) && isFunctionLike(inner.right)) add(inner.left.getText(), inner.right);
    });
    const reached = new Set();
    const queue = [{ fn: effect, chain: ["the address-bar effect"] }];
    while (queue.length) {
      const { fn, chain } = queue.shift();
      if (reached.has(fn)) continue;
      reached.add(fn);
      if (paidFunctions.has(fn) && fn !== effect) fail(`a link can reach a paid fetch: ${chain.join(" → ")}`);
      walk(fn, (inner) => {
        if (inner !== fn && isFunctionLike(inner) && paidFunctions.has(inner)) fail(`a link can reach a paid fetch: ${chain.join(" → ")} → a function at ${where(sf, inner)}`);
        if (!ts.isCallExpression(inner)) return;
        const callee = inner.expression.getText().replace(/\?\.?$/, "").replace(/\?\./g, ".");
        for (const target of declarations.get(callee) ?? []) queue.push({ fn: target, chain: [...chain, `${callee} (${where(sf, target)})`] });
      });
    }
  }
}

// Pages and components outside /api never reach a provider themselves: a server page that ran an analysis would
// spend on a plain GET of its address (a link, a crawler, a prefetch).
for (const file of clientFiles) {
  const sf = parse(file);
  walk(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && /(?:^|\/)(?:pipeline|copy-hunt|scout|daily-budget|remote-budget|telem)(?:\.ts)?$/.test(node.moduleSpecifier.text)) fail(`${where(sf, node)}: imports ${node.moduleSpecifier.text}, which calls a paid provider; only /api routes may`);
    if (ts.isStringLiteralLike(node) && /api\.anthropic\.com|api\.tavily\.com|router\.telem\.ai/.test(node.text)) fail(`${where(sf, node)}: names a provider's address`);
    if (ts.isPropertyAccessExpression(node) && /^(?:ANTHROPIC_API_KEY|TAVILY_API_KEY|TELEM_API_KEY)$/.test(node.name.text)) fail(`${where(sf, node)}: reads ${node.name.text} outside /api`);
  });
}

// Server routes: only POST spends. The status GET reads the ledger and never runs an analysis.
{
  const exportsOf = (file) => {
    const sf = parse(file);
    const names = new Map();
    const exported = (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) names.set(statement.name.text, statement);
      // export const GET = …, and export { GET } (a re-export the check cannot read is named so it fails review).
      if (ts.isVariableStatement(statement) && exported(statement)) for (const declaration of statement.declarationList.declarations) if (/^[A-Z]+$/.test(declaration.name.getText())) names.set(declaration.name.getText(), declaration);
      if (ts.isExportDeclaration(statement)) names.set(`export { ${statement.exportClause?.getText() ?? "*"} }`, statement);
    }
    return { sf, names };
  };
  for (const route of ["claims", "copy-hunt", "compare"]) {
    const { names } = exportsOf(path.join(appDir, "api", route, "route.ts"));
    if ([...names.keys()].some((name) => name !== "POST")) fail(`/api/${route} exports ${[...names.keys()].join(", ")}; only POST is reviewed (a GET could be a link)`);
  }
  const { sf, names } = exportsOf(path.join(appDir, "api", "analyze", "route.ts"));
  const get = names.get("GET");
  if (!get) fail("/api/analyze has no GET: the claim box's status check needs it");
  else walk(get, (node) => { if (ts.isIdentifier(node) && /^(?:analyzeClaim|huntCopies|searchTavily|callClaude)$/.test(node.text)) fail(`${where(sf, node)}: /api/analyze's GET uses ${node.text}; a link or prefetch would spend`); });
}

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: the harness.

const load = createRequire(import.meta.url);
const compile = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  module._compile(output, filename);
};
load.extensions[".ts"] = compile;
load.extensions[".tsx"] = compile;

// A stand-in React: function components, state, refs, memos and effects (in order, after each render), keyed by place
// in the tree so state survives re-renders. Elements are plain objects; host elements keep their props (handlers too).
const Fragment = Symbol("Fragment");
const react = (() => {
  const instances = new Map();
  let current = null;
  let dirty = false;
  let effects = [];
  let rendered = new Set();
  const slot = () => [current, current.index++];
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const api = {
    Fragment,
    useState(initial) {
      const [instance, index] = slot();
      if (!(index in instance.hooks)) {
        const hook = { value: typeof initial === "function" ? initial() : initial };
        hook.set = (next) => {
          const value = typeof next === "function" ? next(hook.value) : next;
          if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; }
        };
        instance.hooks[index] = hook;
      }
      return [instance.hooks[index].value, instance.hooks[index].set];
    },
    useReducer(reducer, initial) {
      const [value, set] = api.useState(initial);
      return [value, (action) => set((state) => reducer(state, action))];
    },
    useRef(initial) {
      const [instance, index] = slot();
      instance.hooks[index] ??= { current: initial };
      return instance.hooks[index];
    },
    useMemo(make, deps) {
      const [instance, index] = slot();
      const hook = instance.hooks[index];
      if (!hook || !same(hook.deps, deps)) instance.hooks[index] = { value: make(), deps };
      return instance.hooks[index].value;
    },
    useCallback(fn, deps) { return api.useMemo(() => fn, deps); },
    useEffect(effect, deps) {
      const [instance, index] = slot();
      const hook = instance.hooks[index] ?? { cleanup: null };
      instance.hooks[index] = hook;
      if (hook.deps !== undefined && deps !== undefined && same(hook.deps, deps)) return;
      hook.deps = deps ?? null;
      effects.push(() => {
        hook.cleanup?.();
        const cleanup = effect();
        hook.cleanup = typeof cleanup === "function" ? cleanup : null;
      });
    },
    useLayoutEffect(effect, deps) { return api.useEffect(effect, deps); },
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
    useId() { const [instance, index] = slot(); return `id-${instance.key.length}-${index}`; },
    useTransition() { return [false, (fn) => fn()]; },
    useDeferredValue(value) { return value; },
    createElement(type, props, ...children) { return { $el: true, type, key: props?.key ?? null, props: { ...props, children: children.length > 1 ? children : children[0] } }; },
    jsx(type, props, key) { return { $el: true, type, key: key ?? null, props: props ?? {} }; },
  };
  api.jsxs = api.jsx;
  api.jsxDEV = api.jsx;
  const renderNode = (node, key) => {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${child?.key ?? index}`));
    if (!node.$el) return null;
    if (node.type === Fragment) return renderNode(node.props.children, key);
    if (typeof node.type === "function") {
      const instanceKey = `${key}/${node.type.name || "anonymous"}${node.key !== null ? `#${node.key}` : ""}`;
      const instance = instances.get(instanceKey) ?? { key: instanceKey, hooks: [] };
      instances.set(instanceKey, instance);
      rendered.add(instanceKey);
      instance.index = 0;
      const previous = current;
      current = instance;
      try {
        return renderNode(node.type(node.props), instanceKey);
      } finally {
        current = previous;
      }
    }
    const { children, ...props } = node.props;
    return { type: node.type, props, children: renderNode(children, `${key}/${node.type}`) };
  };
  return {
    api,
    reset() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); instances.clear(); effects = []; dirty = false; },
    render(element) {
      rendered = new Set();
      dirty = false;
      const tree = renderNode(element, "root");
      for (const [key, instance] of instances) if (!rendered.has(key)) { for (const hook of instance.hooks) hook?.cleanup?.(); instances.delete(key); }
      const queued = effects;
      effects = [];
      return { tree, queued };
    },
    get dirty() { return dirty; },
  };
})();

// Browser stand-ins: a window with an address bar, history, listeners and fake timers; storage; a recorded fetch.
const harness = {
  origin: "http://localhost:3000",
  requests: [],
  phase: "load",
  listeners: new Map(),
  timers: [],
  now: Date.UTC(2026, 10, 14, 18, 0, 0),
  nextTimer: 1,
  storage: new Map(),
  config: null,
  statusFails: false,
  traceDelayMs: 0,
  paidDelayMs: 0,
  analyzeEvents: null,
  errors: [],
  // /embed: the extension origins /api/embed lists (ECHO_EXTENSION_ORIGINS).
  embedOrigins: [],
};
const RealDate = Date;
class HarnessDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [harness.now])); }
  static now() { return harness.now; }
}
const elementStub = () => ({ focus() {}, scrollIntoView() {}, click() {}, setAttribute() {}, closest: () => null, getBoundingClientRect: () => ({ width: 1000, height: 600, top: 0, left: 0 }), style: {} });
const addListener = (target) => (type, handler) => harness.listeners.set(`${target}:${type}`, [...(harness.listeners.get(`${target}:${type}`) ?? []), handler]);
const removeListener = (target) => (type, handler) => harness.listeners.set(`${target}:${type}`, (harness.listeners.get(`${target}:${type}`) ?? []).filter((entry) => entry !== handler));
const schedule = (repeat) => (callback, delay = 0) => { const id = harness.nextTimer++; harness.timers.push({ id, due: harness.now + Math.max(0, Number(delay) || 0), callback, repeat: repeat ? Math.max(1, Number(delay) || 1) : 0 }); return id; };
const unschedule = (id) => { harness.timers = harness.timers.filter((timer) => timer.id !== id); };
const location = {
  href: `${harness.origin}/`,
  get origin() { return new URL(this.href).origin; },
  get pathname() { return new URL(this.href).pathname; },
  get search() { return new URL(this.href).search; },
  get hash() { return new URL(this.href).hash; },
};
const windowStub = {
  location,
  history: { replaceState: (_state, _title, url) => { location.href = new URL(url, location.href).href; }, pushState: (_state, _title, url) => { location.href = new URL(url, location.href).href; } },
  addEventListener: addListener("window"),
  removeEventListener: removeListener("window"),
  setTimeout: schedule(false),
  clearTimeout: unschedule,
  setInterval: schedule(true),
  clearInterval: unschedule,
  requestAnimationFrame: (callback) => schedule(false)(() => callback(harness.now), 16),
  cancelAnimationFrame: unschedule,
  scrollTo() {},
  open: () => null,
  alert() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
};
// Not framed and not opened by another window, unless a test says so (the side panel's frame, Open full result).
windowStub.parent = windowStub;
windowStub.opener = null;
const documentStub = {
  getElementById: () => elementStub(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => elementStub(),
  addEventListener: addListener("document"),
  removeEventListener: removeListener("document"),
  visibilityState: "visible",
  fullscreenElement: null,
  body: elementStub(),
  documentElement: { ...elementStub(), requestFullscreen: async () => {} },
  exitFullscreen: async () => {},
};
const navigatorStub = { onLine: true, clipboard: { writeText: async () => {} }, userAgent: "echo-check-links" };
const localStorageStub = {
  getItem: (key) => (harness.storage.has(key) ? harness.storage.get(key) : null),
  setItem: (key, value) => { harness.storage.set(key, String(value)); },
  removeItem: (key) => { harness.storage.delete(key); },
  clear: () => harness.storage.clear(),
  key: (index) => [...harness.storage.keys()][index] ?? null,
  get length() { return harness.storage.size; },
};
const harnessFetch = async (input, init = {}) => {
  const url = new URL(String(input), location.href);
  const method = String(init.method ?? "GET").toUpperCase();
  harness.requests.push({ phase: harness.phase, method, path: url.pathname, body: typeof init.body === "string" ? init.body : null, signal: init.signal ?? null });
  if (url.origin !== harness.origin) throw new TypeError("the harness has no network");
  // A slow network, in fake time: bundled traces after `traceDelayMs`, paid answers after `paidDelayMs`.
  const delay = url.pathname.startsWith("/demo-traces/") ? harness.traceDelayMs : PAID_PATH.test(url.pathname) && method !== "GET" ? harness.paidDelayMs : 0;
  if (delay) await new Promise((resolve) => windowStub.setTimeout(resolve, delay));
  if (url.pathname === "/api/embed" && method === "GET") return Response.json({ extensionOrigins: harness.embedOrigins });
  if (url.pathname === "/api/analyze" && method === "GET") {
    if (harness.statusFails) throw new TypeError("Failed to fetch");
    return Response.json(harness.config);
  }
  if (url.pathname.startsWith("/demo-traces/") && method === "GET") {
    const file = path.join(root, "public", url.pathname);
    return file.startsWith(path.join(root, "public", "demo-traces")) && fs.existsSync(file) ? new Response(fs.readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } }) : new Response("missing", { status: 404 });
  }
  // A test can have /api/analyze answer with a stream of [event, data] (a result, a failure with its receipt).
  if (url.pathname === "/api/analyze" && method === "POST" && harness.analyzeEvents) {
    return new Response(harness.analyzeEvents.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
  if (PAID_PATH.test(url.pathname)) return Response.json({ code: "HARNESS", error: "The harness answers no paid request." }, { status: 403 });
  return new Response("not found", { status: 404 });
};
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class HTMLElementStub {}
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const saved = Object.fromEntries(["window", "document", "navigator", "localStorage", "fetch", "Date", "ResizeObserver", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
define("window", windowStub);
define("document", documentStub);
define("navigator", navigatorStub);
define("localStorage", localStorageStub);
define("fetch", harnessFetch);
define("Date", HarnessDate);
define("ResizeObserver", ResizeObserverStub);
define("HTMLElement", HTMLElementStub);
define("requestAnimationFrame", windowStub.requestAnimationFrame);
define("cancelAnimationFrame", unschedule);

const stubs = {
  react: react.api,
  "react/jsx-runtime": react.api,
  "react/jsx-dev-runtime": react.api,
  "react-dom": { createPortal: (children) => children },
  "next/link": { __esModule: true, default: function Link({ children, href, ...props }) { return { $el: true, type: "a", key: null, props: { ...props, href: String(href), children } }; } },
};
const resolveFilename = Module._resolveFilename;
const moduleLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
  return resolveFilename.call(this, request.startsWith("@/") ? path.join(root, "src", request.slice(2)) : request, ...rest);
};
Module._load = function (request, ...rest) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  if (request.endsWith(".css")) return new Proxy({}, { get: (_target, key) => (key === "__esModule" ? false : String(key)) });
  return moduleLoad.call(this, request, ...rest);
};
const EchoWorkbench = load("../src/app/echo-workbench.tsx").default;
// /embed renders the workbench in its side-panel layout (src/app/embed/page.tsx), the page itself as the server sends it.
const EmbedPage = load("../src/app/embed/page.tsx").default;
const { bookmarkletCode } = load("../src/lib/echo/bookmarklet.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));
let tree = null;

/** Renders until nothing changes: effects, then promises, then timers up to `horizonMs` of fake time. */
async function run(horizonMs = 0) {
  const until = harness.now + horizonMs;
  for (let round = 0; round < 400; round += 1) {
    const { tree: next, queued } = react.render({ $el: true, type: location.pathname === "/embed" ? EmbedPage : EchoWorkbench, key: null, props: {} });
    tree = next;
    for (const effect of queued) {
      try { effect(); } catch (error) { harness.errors.push(error); }
    }
    for (let tick = 0; tick < 12; tick += 1) await settle();
    if (react.dirty) continue;
    const due = harness.timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due)[0];
    if (!due) return tree;
    harness.now = Math.max(harness.now, due.due);
    if (due.repeat) due.due += due.repeat; else unschedule(due.id);
    try { due.callback(); } catch (error) { harness.errors.push(error); }
    for (let tick = 0; tick < 12; tick += 1) await settle();
  }
  // A render loop (an effect that keeps setting state) is a failure of its own; what it sent is still checked.
  harness.errors.push(new Error("the workbench did not settle in 400 renders (an effect keeps changing state)"));
  return tree;
}

/** Loads Echo at `address` from scratch: a new tab with empty storage, then two minutes with nobody at the keyboard. */
async function open(address, { config = { anthropicConfigured: true, tavilyConfigured: true, copyHuntEnabled: true, liveRunsLocked: false, dailyBudget: { capUsd: 2, spentUsd: 0.4, reservedUsd: 0, available: true, storage: "local" } }, statusFails = false, online = true } = {}) {
  react.reset();
  Object.assign(harness, { requests: [], phase: "load", listeners: new Map(), timers: [], storage: new Map(), config, statusFails, errors: [], traceDelayMs: 0, paidDelayMs: 0, analyzeEvents: null });
  navigatorStub.onLine = online;
  location.href = new URL(address, harness.origin).href;
  await run();
  // Things that happen with nobody pressing anything: the tab regains focus or visibility, storage changes in another
  // tab, the network comes and goes, a service worker takes over. Each listener the app attached is fired.
  harness.phase = "idle";
  for (const [key, handlers] of [...harness.listeners]) {
    const type = key.split(":")[1];
    if (USER_LISTENERS.has(type)) continue;
    for (const handler of handlers) {
      try { handler({ type, target: windowStub, key: null, preventDefault() {}, defaultPrevented: false }); } catch (error) { harness.errors.push(error); }
    }
  }
  await run(120_000);
  return tree;
}

const nodes = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((child) => nodes(child, out));
  else if (node && typeof node === "object") { out.push(node); nodes(node.children, out); }
  return out;
};
const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" ? node : node && typeof node === "object" ? textOf(node.children) : "");
const find = (predicate) => nodes(tree).find(predicate) ?? null;
const claimBox = () => find((node) => node.type === "input" && node.props.id === "claim-input");
const paidRequests = () => harness.requests.filter((request) => request.method !== "GET" && PAID_PATH.test(request.path));

const CLAIM = "Americans check their phones 96 times a day";
const links = [
  [`/?claim=${encodeURIComponent(CLAIM)}`, { claim: CLAIM }],
  [`/?claim=${encodeURIComponent("https://news.example/story?id=7")}`, { claim: "https://news.example/story?id=7" }],
  [`/?claim=${encodeURIComponent(`${CLAIM}&forceFresh=true`)}`, { claim: `${CLAIM}&forceFresh=true` }],
  [`/?claim=${encodeURIComponent(CLAIM)}&slot=03`, { claim: CLAIM }],
  [`/?claim=${encodeURIComponent(CLAIM)}&autorun=1&run=1&forceFresh=1`, { claim: CLAIM }],
  // Deep search is the claim box's toggle only: no parameter turns it on (the loop checks the toggle after each link).
  [`/?claim=${encodeURIComponent(CLAIM)}&searchMode=deep&mode=deep&deep=1&depth=deep`, { claim: CLAIM }],
  ["/?slot=02&searchMode=deep&deep=1", { saved: "americans-check-phones-96-times" }],
  ["/?slot=01", { saved: "humans-use-10-percent-of-brain" }],
  ["/?slot=02", { saved: "americans-check-phones-96-times" }],
  ["/?slot=phones", { saved: "americans-check-phones-96-times" }],
  ["/?slot=03", { empty: true }],
  ["/?slot=3", { empty: true }],
  ["/?slot=99", { empty: true }],
  ["/?trace=goldfish-3-second-memory", { saved: "goldfish-3-second-memory" }],
  ["/?trace=lose-most-body-heat-through-head", { saved: "lose-most-body-heat-through-head" }],
  ["/?trace=americans-check-phones-96-times", { saved: "americans-check-phones-96-times" }],
  // The saved Check these sources run: opens the bundled result; it never fills the panel or runs its links.
  ["/?trace=check-these-sources-phones", { saved: "check-these-sources-phones", sources: null }],
  [`/?trace=check-these-sources-phones&claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent("https://a.example/one")}`, { saved: "check-these-sources-phones", sources: null }],
  ["/?trace=..%2F..%2Fapi%2Fanalyze", { empty: true }],
  ["/?trace=nope", { empty: true }],
  [`/?slot=02&claim=${encodeURIComponent("Goldfish have a 3-second memory")}`, { saved: "americans-check-phones-96-times" }],
  ["/?urls=https%3A%2F%2Fa.example%2F,https%3A%2F%2Fb.example%2F", { empty: true, sources: { urls: ["https://a.example/", "https://b.example/"], claim: "" } }],
  [`/?claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent("https://a.example/one https://b.example/two?utm_source=chatgpt.com")}`, { empty: true, sources: { urls: ["https://a.example/one", "https://b.example/two"], claim: CLAIM } }],
  [`/?claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent("https://a.example/one")}&autorun=1&run=1&forceFresh=1`, { empty: true, sources: { urls: ["https://a.example/one"], claim: CLAIM } }],
  [`/?urls=${encodeURIComponent(Array.from({ length: 25 }, (_, index) => `https://n${index}.example/x`).join(" "))}`, { empty: true, sources: { urls: Array.from({ length: 20 }, (_, index) => `https://n${index}.example/x`), claim: "" } }],
  ["/?urls=javascript%3Aalert(1)", { empty: true, sources: null }],
  // ?nums= (Copy link of a run whose answer numbered its links [2]–[3]) only numbers the chips; nothing runs.
  [`/?claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent("https://a.example/one https://b.example/two")}&nums=2,3`, { empty: true, sources: { urls: ["https://a.example/one", "https://b.example/two"], claim: CLAIM } }],
  [`/?urls=${encodeURIComponent("https://a.example/one")}&nums=${encodeURIComponent("1,2,javascript:alert(1)")}`, { empty: true, sources: { urls: ["https://a.example/one"], claim: "" } }],
  [`/?slot=02&urls=${encodeURIComponent("https://a.example/one")}`, { saved: "americans-check-phones-96-times" }],
  ["/?claim=", { empty: true }],
  ["/#claim=Goldfish%20have%20a%203-second%20memory", { empty: true }],
];

// The extension's links, built by its own link builder, and the bookmarklet's, run as a browser would.
{
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, "extension", "echo-link.js"), "utf8"), context);
  const { claimLink, pageLink, sourcesLink, linkSourcesLink } = context.EchoLink;
  const site = harness.origin;
  const made = [
    claimLink(site, CLAIM),
    claimLink(site, ""),
    claimLink(site, `  ${CLAIM}\n&slot=03#run `),
    claimLink(site, "x".repeat(2_000)),
    pageLink(site, "https://news.example/story?id=7#comments"),
    pageLink(site, "javascript:alert(1)"),
    pageLink(site, `https://news.example/${"y".repeat(600)}`),
  ];
  const bookmark = (selection, typed = null) => {
    const opened = [];
    const fakeWindow = { getSelection: () => ({ toString: () => selection }), prompt: () => typed, open: (...args) => { opened.push(args[0]); return null; } };
    vm.runInNewContext(bookmarkletCode(site), { window: fakeWindow });
    return opened;
  };
  made.push(...bookmark(CLAIM), ...bookmark("", "Goldfish have a 3-second memory"), ...bookmark(`${CLAIM}'); fetch('/api/analyze',{method:'POST'}); ('`));
  for (const link of made) {
    const url = new URL(link);
    if (url.origin !== site || url.pathname !== "/" || [...url.searchParams.keys()].some((key) => key !== "claim") || url.hash) fail(`an extension or bookmarklet link opens ${link}; it may only open ${site}/ or ${site}/?claim=`);
    const claim = url.searchParams.get("claim");
    links.push([link, claim ? { claim: claim.replace(/\s+/g, " ").trim().slice(0, 500) } : { empty: true }]);
  }
  // Check links with Echo / Check this link with Echo: ?urls= (and ?claim=), which only fill the sources panel.
  const { urlsFromParam } = load(path.join(root, "src", "lib", "echo", "supplied-urls.ts"));
  const answer = `Americans check their phones 96 times a day [1][2].\n[1] https://a.example/one?utm_source=x\n[2] http://b.example/two#top.`;
  const sourceLinks = [
    sourcesLink(site, answer),
    sourcesLink(site, `${Array.from({ length: 30 }, (_, index) => `https://n${index}.example/x`).join(" ")} 90% of startups fail, a study found.`),
    sourcesLink(site, "javascript:alert(1) and no web address"),
    sourcesLink(site, `https://a.example/one'); fetch('/api/analyze',{method:'POST'}); ('`),
    linkSourcesLink(site, "https://news.example/story?id=7#comments"),
    linkSourcesLink(site, "javascript:alert(1)"),
    linkSourcesLink(site, `https://news.example/${"y".repeat(2_100)}`),
  ];
  for (const link of sourceLinks) {
    const url = new URL(link);
    const keys = [...url.searchParams.keys()];
    if (url.origin !== site || url.pathname !== "/" || keys.some((key) => key !== "claim" && key !== "urls") || url.hash) fail(`an extension sources link opens ${link}; it may only open ${site}/ with ?urls= and ?claim=`);
    const claim = (url.searchParams.get("claim") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const urls = urlsFromParam(url.searchParams.get("urls")).slice(0, 20);
    links.push([link, urls.length ? { empty: true, sources: { urls, claim } } : claim ? { claim } : { empty: true }]);
  }
}

const SETUPS = {
  "keys ready": {},
  "presenter-locked": { config: { anthropicConfigured: true, tavilyConfigured: true, copyHuntEnabled: true, liveRunsLocked: true, dailyBudget: { capUsd: 2, spentUsd: 0, reservedUsd: 0, available: true, storage: "shared" } } },
  "keys missing": { config: { anthropicConfigured: false, tavilyConfigured: false, copyHuntEnabled: false, liveRunsLocked: false, dailyBudget: { capUsd: 2, spentUsd: 0, reservedUsd: 0, available: true, storage: "local" } } },
  "status check failing, offline": { statusFails: true, online: false },
};

// The side panel's page, /embed: its address fills the box like any other and runs nothing, even framed by an
// allowlisted extension (every link below loads that way: a framed page that ignored the gate would spend here).
const EMBED_EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const embedParent = { posted: [], postMessage(data, targetOrigin) { this.posted.push({ data, targetOrigin }); } };
{
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, "extension", "echo-link.js"), "utf8"), context);
  const { embedLink, jobTabLink } = context.EchoLink;
  const site = harness.origin;
  links.push(
    [`/embed?claim=${encodeURIComponent(CLAIM)}`, { claim: CLAIM }],
    [`/embed?claim=${encodeURIComponent(CLAIM)}&autorun=1&run=1&forceFresh=1&embed=1&start=1`, { claim: CLAIM }],
    ["/embed", { empty: true }],
    ["/embed?slot=", { empty: true }],
    [`/?embed=1&claim=${encodeURIComponent(CLAIM)}`, { claim: CLAIM }],
    [`/?embed=1&start=1&claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent("https://a.example/one")}`, { empty: true, sources: { urls: ["https://a.example/one"], claim: CLAIM } }],
  );
  const made = [
    [embedLink(site, { kind: "trace", claim: CLAIM }), "/embed"],
    [embedLink(site, null), "/embed"],
    [embedLink(site, { kind: "trace", claim: `${"x".repeat(2_000)} &autorun=1` }), "/embed"],
    [jobTabLink(site, { kind: "trace", claim: CLAIM }), "/"],
    [jobTabLink(site, null), "/"],
  ];
  for (const [link, pathname] of made) {
    const url = new URL(link);
    if (url.origin !== site || url.pathname !== pathname || [...url.searchParams.keys()].some((key) => key !== "claim") || url.hash) fail(`the side panel opens ${link}; it may only open ${site}${pathname} or ${site}${pathname}?claim=`);
    const claim = url.searchParams.get("claim");
    links.push([url.pathname + url.search, claim ? { claim: claim.replace(/\s+/g, " ").trim().slice(0, 500) } : { empty: true }]);
  }
  const linkJob = embedLink(site, { kind: "links", claim: CLAIM, urls: ["https://a.example/one", "https://b.example/two"] });
  const linkTab = jobTabLink(site, { kind: "links", claim: CLAIM, urls: ["https://a.example/one", "https://b.example/two"] });
  for (const [link, pathname] of [[linkJob, "/embed"], [linkTab, "/"]]) {
    const url = new URL(link);
    if (url.pathname !== pathname || [...url.searchParams.keys()].some((key) => key !== "claim" && key !== "urls")) fail(`the side panel's links job opens ${link}; it may only fill ${pathname} with ?urls= and ?claim=`);
  }
  // A /embed ?urls= link has no claim box (the sources panel replaces it): checked in the start-message block below.
  links.push([new URL(linkTab).pathname + new URL(linkTab).search, { empty: true, sources: { urls: ["https://a.example/one", "https://b.example/two"], claim: CLAIM } }]);
}
harness.embedOrigins = [EMBED_EXT];
windowStub.parent = embedParent;

let opened = 0;
for (const [address, expected] of links) {
  for (const [setup, options] of Object.entries(SETUPS)) {
    const label = `${address.slice(0, 90)} (${setup})`;
    await open(address, options);
    opened += 1;
    const sent = paidRequests();
    if (sent.length) fail(`${label}: sent ${sent.length} paid request(s) with nobody pressing anything, first ${sent[0].method} ${sent[0].path} during ${sent[0].phase}`);
    for (const error of new Set(harness.errors.map((error) => error?.stack?.split("\n").slice(0, 2).join(" ") ?? String(error)))) fail(`${label}: the workbench threw ${error}`);
    const box = claimBox();
    if (!box) { fail(`${label}: no claim box rendered`); continue; }
    const deepToggle = find((node) => node.type === "button" && node.props["data-mode"] === "deep");
    if (deepToggle && deepToggle.props["aria-checked"] !== false) fail(`${label}: the Deep toggle is on after opening a link`);
    const shown = textOf(tree);
    if (expected.claim !== undefined && box.props.value !== expected.claim) fail(`${label}: the claim box holds “${box.props.value}”, expected the link's claim “${expected.claim}”`);
    if (expected.saved) {
      const fetched = harness.requests.some((request) => request.method === "GET" && request.path === `/demo-traces/${expected.saved}.echo.json`);
      if (!fetched || !shown.includes("SAVED LIVE RUN")) fail(`${label}: expected the saved run ${expected.saved} to open (fetched: ${fetched})`);
    }
    if (expected.empty && (box.props.value !== "" || shown.includes("SAVED LIVE RUN"))) fail(`${label}: expected an empty claim box and no run, got “${box.props.value}”`);
    if (expected.sources !== undefined) {
      const text = find((node) => node.type === "textarea" && node.props.id === "source-check-text");
      const sourceClaim = find((node) => node.type === "input" && node.props.id === "source-check-claim");
      const chips = nodes(tree).filter((node) => node.type === "li" && node.props.title && /^https?:/.test(node.props.title)).map((node) => node.props.title);
      if (expected.sources === null && text) fail(`${label}: expected no sources panel, but it opened`);
      if (expected.sources && (!text || !sourceClaim)) fail(`${label}: expected the sources panel to open filled from the link`);
      else if (expected.sources && (JSON.stringify(chips) !== JSON.stringify(expected.sources.urls) || sourceClaim.props.value !== expected.sources.claim)) fail(`${label}: the sources panel shows ${JSON.stringify(chips)} and “${sourceClaim.props.value}”, expected ${JSON.stringify(expected.sources.urls)} and “${expected.sources.claim}”`);
    }
  }
}

// The harness sees a paid request when a person does press: Trace sources, Find claims in this page, Check N sources,
// Hunt for copies.
{
  const press = async (label, act, route) => {
    harness.phase = "user";
    act();
    await run(5_000);
    const sent = paidRequests().filter((request) => request.phase === "user" && request.path === route);
    if (sent.length !== 1) fail(`control: ${label} should send one POST ${route}; the harness saw ${sent.length}, so it may not see a paid request at all`);
  };
  const submit = () => find((node) => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await open(`/?claim=${encodeURIComponent("Goldfish remember things for months, not seconds")}`);
  await press("pressing Trace sources", submit, "/api/analyze");
  // A link asking for Deep still sends a Standard run (no searchMode in the body); only the toggle sends "deep".
  await open(`/?claim=${encodeURIComponent("Goldfish remember things for months, not seconds")}&searchMode=deep&deep=1`);
  await press("pressing Trace sources after a link asking for Deep", submit, "/api/analyze");
  const linkBody = JSON.parse(paidRequests().find((request) => request.phase === "user" && request.path === "/api/analyze")?.body ?? "{}");
  if ("searchMode" in linkBody) fail(`control: a link asking for Deep sent searchMode ${JSON.stringify(linkBody.searchMode)}`);
  await open(`/?claim=${encodeURIComponent("Goldfish remember things for months, not seconds")}`);
  const deepButton = () => find((node) => node.type === "button" && node.props["data-mode"] === "deep");
  if (!deepButton()) fail("control: the Deep toggle did not render in the claim box");
  else {
    harness.phase = "user";
    deepButton().props.onClick({ preventDefault() {} });
    await run(1_000);
    if (paidRequests().length) fail("control: choosing Deep sent a paid request by itself");
    if (deepButton().props["aria-checked"] !== true) fail("control: the Deep toggle did not turn on when pressed");
    await press("pressing Trace sources with Deep chosen", submit, "/api/analyze");
    const deepBody = JSON.parse(paidRequests().find((request) => request.phase === "user" && request.path === "/api/analyze")?.body ?? "{}");
    if (deepBody.searchMode !== "deep") fail(`control: Trace sources with Deep chosen sent ${JSON.stringify(deepBody)}`);
  }
  await open(`/?claim=${encodeURIComponent("https://news.example/story")}`);
  await press("pressing Find claims in this page", submit, "/api/claims");
  await open(`/?claim=${encodeURIComponent("Americans check their phones 96 times a day")}&urls=${encodeURIComponent("https://a.example/one https://b.example/two")}`);
  const sourcesButton = () => nodes(tree).find((node) => node.type === "button" && /^Check \d+ sources?/.test(textOf(node)));
  if (!sourcesButton()) fail("control: the Check these sources button did not render from a ?urls= link");
  else {
    await press("pressing Check 2 sources", () => sourcesButton().props.onClick({ preventDefault() {} }), "/api/analyze");
    const body = JSON.parse(paidRequests().find((request) => request.phase === "user" && request.path === "/api/analyze")?.body ?? "{}");
    if (JSON.stringify(body.urls) !== JSON.stringify(["https://a.example/one", "https://b.example/two"]) || body.claim !== "Americans check their phones 96 times a day") fail(`control: Check 2 sources sent ${JSON.stringify(body)}`);
  }
  await open("/?slot=02");
  // The saved phones run carries a copy hunt, so its button reads "Search again".
  const hunt = () => nodes(tree).find((node) => node.type === "button" && /^(?:Hunt for more copies|Search again)/.test(textOf(node)));
  if (!hunt()) fail("control: the copy-hunt button did not render on the saved phones run");
  else await press("pressing the copy hunt's button", () => hunt().props.onClick({ preventDefault() {} }), "/api/copy-hunt");
}

// Odd but valid trace files, opened with Open trace file and shown in Present mode: none may throw or spend.
const openTraceFile = async (portable, name) => {
  const input = find((node) => node.type === "input" && node.props["aria-label"] === "Open saved Echo trace file");
  const text = JSON.stringify(portable);
  harness.phase = "user";
  harness.now += 1_000;
  input.props.onChange({ currentTarget: { files: [{ name, size: Buffer.byteLength(text), text: async () => text }], value: name } });
  await run(5_000);
};
const { makePortableTrace } = load("../src/lib/echo/portable.ts");
const { cloneDemoAnalysis } = load("../src/lib/echo/demo-data.ts");
const { ReceiptDraft } = load("../src/lib/echo/cost-receipt.ts");
const phonesFile = JSON.parse(fs.readFileSync(path.join(root, "public", "demo-traces", "americans-check-phones-96-times.echo.json"), "utf8"));
const receipt = (() => {
  const draft = new ReceiptDraft(0.008);
  draft.tavilyRequest("search", "basic", 0, 1);
  draft.claudeRequest({ step: "judgment", model: "claude-sonnet-4-5", inputTokens: 38_002, outputTokens: 4_515, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.1817333 });
  draft.addStage("search", 2_400);
  return draft.finish();
})();
let presented = 0;
let slidesShown = 0;
{
  const variant = (change) => { const file = structuredClone(phonesFile); change(file.analysis); return file; };
  const odd = {
    "a rehearsal fixture": makePortableTrace(cloneDemoAnalysis("brain")),
    "no search audit, copy hunt or cost receipt": variant((analysis) => { delete analysis.searchAudit; delete analysis.copyHunt; delete analysis.costReceipt; }),
    "a first search that failed": variant((analysis) => { analysis.searchAudit[0] = { ...analysis.searchAudit[0], status: "failed", totalResults: 0, matchingResults: 0, uniquePagesAdded: 0, pageIds: [] }; }),
    "a cost receipt": variant((analysis) => { analysis.costReceipt = structuredClone(receipt); }),
    "a supplied-sources run (Check these sources)": variant((analysis) => { delete analysis.searchAudit; analysis.sourceCheck = { urls: [...analysis.pages.map((page) => page.url), "https://unread.example/x"], unreadUrls: ["https://unread.example/x"] }; }),
    "zero pages (the import check refuses it)": variant((analysis) => { analysis.pages = []; analysis.roots = []; analysis.verifiableRoots = []; analysis.answerSourceIds = []; analysis.clusters = []; }),
  };
  for (const [name, file] of Object.entries(odd)) {
    await open("/");
    await openTraceFile(file, `${name}.echo.json`);
    const present = find((node) => node.type === "button" && node.props["aria-label"] === "Start judge-facing presentation");
    if (present) {
      presented += 1;
      present.props.onClick();
      await run(5_000);
      // Every slide, with the presenter's Next button.
      for (let slide = 0; slide < 8; slide += 1) {
        const next = nodes(tree).find((node) => node.type === "button" && textOf(node) === "Next →" && !node.props.disabled);
        if (!next) break;
        next.props.onClick();
        await run(1_000);
        slidesShown += 1;
      }
    }
    const opened = Boolean(present) || /not a supported Echo trace/.test(textOf(tree));
    if (!opened) fail(`trace file with ${name}: neither opened nor refused with a message`);
    for (const error of new Set(harness.errors.map((error) => error?.stack?.split("\n").slice(0, 3).join(" ") ?? String(error)))) fail(`trace file with ${name}: the workbench threw ${error}`);
    if (paidRequests().length) fail(`trace file with ${name}: opening and presenting it sent a paid request`);
  }
}

// The side panel's start message (src/app/embed-bridge.ts). /embed posts its one-time nonce to its parent, addressed to
// each allowlisted extension origin only; it runs exactly one job, from a message whose source is its parent, whose
// origin is allowlisted and whose nonce matches. Every other message (a website, another extension, no or a wrong
// nonce, another window, a replay) and every unframed or unlisted page runs nothing.
let embedChecks = 0;
{
  const OTHER_EXT = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
  const otherWindow = { postMessage() {} };
  const runs = () => paidRequests().filter((request) => request.path === "/api/analyze");
  const readyNonce = () => embedParent.posted.find((entry) => entry.data?.type === "echo:embed-ready")?.data.nonce;
  const openEmbed = async (address, { origins = [EMBED_EXT], framed = true } = {}) => {
    embedParent.posted = [];
    harness.embedOrigins = origins;
    windowStub.parent = framed ? embedParent : windowStub;
    await open(address);
  };
  const fire = async (data, origin = EMBED_EXT, source = embedParent) => {
    harness.phase = "message";
    for (const handler of harness.listeners.get("window:message") ?? []) {
      try { handler({ type: "message", data, origin, source }); } catch (error) { harness.errors.push(error); }
    }
    await run(5_000);
    embedChecks += 1;
  };
  const expectRuns = (label, count) => { if (runs().length !== count) fail(`/embed start message, ${label}: ${runs().length} POST /api/analyze, expected ${count}`); };
  try {
    await openEmbed(`/embed?claim=${encodeURIComponent(CLAIM)}`);
    const nonce = readyNonce();
    const readies = embedParent.posted.filter((entry) => entry.data?.type === "echo:embed-ready");
    if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || readies.length !== 1 || readies[0].targetOrigin !== EMBED_EXT) fail(`/embed framed by an allowlisted extension posted ${JSON.stringify(embedParent.posted)}; expected one ready message with a 32-hex nonce, addressed to ${EMBED_EXT} only`);
    expectRuns("after loading and two idle minutes", 0);
    const start = (extra = {}) => ({ type: "echo:embed-start", nonce, claim: "Goldfish remember things for months, not seconds", ...extra });
    await fire(start(), "https://evil.example");
    await fire(start(), "null");
    await fire(start(), OTHER_EXT);
    await fire(start(), harness.origin);
    await fire(start({ nonce: undefined }));
    await fire(start({ nonce: "0".repeat(32) }));
    await fire(start({ nonce: nonce.toUpperCase() === nonce ? "f".repeat(32) : nonce.toUpperCase() }));
    await fire(start(), EMBED_EXT, otherWindow);
    await fire(start(), EMBED_EXT, null);
    await fire(start({ type: "echo:embed-run" }));
    await fire(start({ claim: "short" }));
    await fire(start({ claim: 42 }));
    await fire(start({ urls: ["javascript:alert(1)"] }));
    await fire(start({ urls: "https://a.example/one" }));
    await fire(JSON.stringify(start()));
    expectRuns("forged messages (a website, another extension, Echo itself, no or a wrong nonce, another window, bad jobs)", 0);
    await fire(start());
    expectRuns("the allowlisted extension's message with the nonce", 1);
    const body = JSON.parse(runs()[0]?.body ?? "{}");
    if (body.claim !== "Goldfish remember things for months, not seconds" || body.urls !== undefined || body.forceFresh) fail(`/embed start message sent ${JSON.stringify(body)}`);
    await fire(start());
    await fire(start({ claim: "Humans use only ten percent of their brains" }));
    expectRuns("the same message again, and a second job", 1);

    await openEmbed("/embed");
    await fire({ type: "echo:embed-start", nonce: readyNonce(), claim: CLAIM, urls: ["https://a.example/one?utm_source=x", "https://b.example/two#top"] });
    expectRuns("a links job", 1);
    const linkBody = JSON.parse(runs()[0]?.body ?? "{}");
    if (JSON.stringify(linkBody.urls) !== JSON.stringify(["https://a.example/one", "https://b.example/two"]) || linkBody.claim !== CLAIM) fail(`/embed links job sent ${JSON.stringify(linkBody)}`);

    // A /embed ?urls= address fills the sources panel and runs nothing (the loop above cannot read it: no claim box).
    await openEmbed(`/embed?urls=${encodeURIComponent("https://a.example/one https://b.example/two")}&claim=${encodeURIComponent(CLAIM)}`);
    const sourceClaim = find((node) => node.type === "input" && node.props.id === "source-check-claim");
    if (sourceClaim?.props.value !== CLAIM) fail(`/embed?urls= did not fill the sources panel (claim “${sourceClaim?.props.value}”)`);
    expectRuns("a /embed ?urls= address", 0);

    for (const [label, address, options] of [
      ["no extension allowlisted", "/embed", { origins: [] }],
      ["not framed (opened in a tab)", "/embed", { framed: false }],
      ["the home page, framed", "/", {}],
      ["the home page with ?embed=1, framed", `/?embed=1&claim=${encodeURIComponent(CLAIM)}`, {}],
    ]) {
      await openEmbed(address, options);
      const leaked = embedParent.posted.length;
      await fire({ type: "echo:embed-start", nonce: readyNonce() ?? "0".repeat(32), claim: CLAIM });
      await fire({ type: "echo:embed-start", nonce: "0".repeat(32), claim: CLAIM }, EMBED_EXT, windowStub);
      if (leaked) fail(`/embed start message, ${label}: posted ${JSON.stringify(embedParent.posted)}; expected no ready message`);
      expectRuns(label, 0);
    }
    for (const error of new Set(harness.errors.map((error) => error?.stack?.split("\n").slice(0, 2).join(" ") ?? String(error)))) fail(`/embed start message: the workbench threw ${error}`);
    if (!failures.some((message) => message.startsWith("/embed"))) inventory.push(`/embed start message: ${embedChecks} messages fired; only the allowlisted extension's, from the parent frame, with the nonce, ran (once)`);

    // Open full result: the tab the side panel opens takes the result from its same-origin opener; nothing runs.
    const openerPosted = [];
    const opener = { location: { origin: harness.origin }, postMessage(data, targetOrigin) { openerPosted.push({ data, targetOrigin }); } };
    windowStub.parent = windowStub;
    windowStub.opener = opener;
    await open(`/?claim=${encodeURIComponent(phonesFile.analysis.claim)}`);
    if (!openerPosted.some((entry) => entry.data?.type === "echo:handoff-ready" && entry.targetOrigin === harness.origin)) fail(`Open full result: the new tab asked its opener ${JSON.stringify(openerPosted)}`);
    await fire({ type: "echo:handoff", trace: phonesFile }, "https://evil.example", opener);
    await fire({ type: "echo:handoff", trace: phonesFile }, harness.origin, otherWindow);
    if (/CACHED LIVE TRACE|SAVED LIVE RUN/.test(textOf(tree))) fail("Open full result: a trace from another origin or window opened");
    await fire({ type: "echo:handoff", trace: phonesFile }, harness.origin, opener);
    if (!/2 independent origins/.test(textOf(tree))) fail("Open full result: the opener's trace did not open");
    if (paidRequests().length) fail(`Open full result sent ${paidRequests().length} paid request(s)`);
    else inventory.push("Open full result: the new tab shows the side panel's trace from its same-origin opener only, and spends nothing");
  } finally {
    windowStub.parent = windowStub;
    windowStub.opener = null;
    harness.embedOrigins = [];
  }
}

// EXPECTED FAILURES in files this check's owner does not edit (src/app outside api, public/). Each block logs its
// failure and keeps the suite green, and says so once the case passes; then turn it into a plain check.
const expectedFailure = async (todo, check) => {
  try {
    await check();
    console.log(`  note  an expected failure now passes; make it a plain check: ${todo}`);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    console.log(`  expected failure (TODO feature agent, ${todo}): ${error.message.split("\n")[0]}`);
  }
};
// A fixed bug that must stay fixed: a failed assertion here fails the check.
const plainCheck = async (name, check) => {
  try {
    await check();
    inventory.push(name);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    fail(`${name}: ${error.message.split("\n")[0]}`);
  }
};

// UI review, round 5 (11/14): five bugs, expected failures until main fixed them on 11/13; now plain checks.
// 1. The claim box printed a spend it never read. Before /api/analyze's GET answers, or when it fails (offline, a
// cold server), dailyBudget held its useState default, so the box read "Echo API (Claude + Tavily): $0.00
// spent / $2.00 daily cap · local ledger" under "Could not check live setup". Repro: load the app offline.
await plainCheck("with no status answer, the claim box names no spend figure", async () => {
  await open("/", { statusFails: true });
  assert.ok(textOf(find((node) => node.props?.className?.startsWith?.("key-note"))).includes("Could not check live setup"), "the harness shows the failed status check");
  assert.doesNotMatch(textOf(tree), /\$0\.00 spent/, "with no status answer the claim box names no spend figure");
});
// 2. The glossary's worked example was ungrammatical: "The saved phones run's reads “13 pages → 2 independent origins”."
await plainCheck("the glossary's verdict-banner example reads as a sentence", async () => {
  await open("/");
  harness.phase = "user";
  find((node) => node.type === "details" && node.props.id === "glossary").props.onToggle({ currentTarget: { open: true } });
  await run(5_000);
  const glossary = textOf(find((node) => node.type === "details" && node.props.id === "glossary"));
  assert.match(glossary, /phones run/, "the glossary's example loaded");
  assert.doesNotMatch(glossary, /run's reads/, "the verdict-banner example reads as a sentence");
});
// 3. A file the person opened got "Embed badge" (and Copy link gave ?slot=02) when its claim and createdAt equalled a
// bundled run's, though its pages differed: bundledTrace (ResultView) matched on claim and createdAt, not on the
// bundled-run stamp that isBundledRun uses. Repro: Save trace file on slot 02, change a judgment in the file, reload,
// Open trace file: "IMPORTED TRACE FILE" with an "Embed badge" button.
await plainCheck("an imported look-alike of a bundled run offers no Embed badge", async () => {
  await open("/");
  const edited = structuredClone(phonesFile);
  edited.analysis.pages[0].title = `${edited.analysis.pages[0].title} (edited)`;
  await openTraceFile(edited, "edited-phones.echo.json");
  assert.match(textOf(tree), /IMPORTED TRACE FILE/, "the edited file is labelled imported");
  // The badge sits in the result toolbar's More disclosure.
  const more = find((node) => node.type === "button" && /^More/.test(textOf(node)) && node.props["aria-expanded"] !== undefined);
  if (more) { more.props.onClick(); await run(); }
  assert.ok(find((node) => node.type === "button" && textOf(node) === "Save trace file"), "the More actions are open");
  assert.equal(find((node) => node.type === "button" && textOf(node) === "Embed badge"), null, "an imported file offers no badge for the bundled run");
});
// 4. A trace file's cost line read as this view's spend: costReceiptLine said "not new spend" only for cacheHit, and an
// opened file has cacheHit false. Repro: Save trace file after a fresh run, Open it.
await plainCheck("an opened trace file's cost line says it is the original run's spend", async () => {
  await open("/");
  const withReceipt = structuredClone(phonesFile);
  withReceipt.analysis.costReceipt = structuredClone(receipt);
  await openTraceFile(withReceipt, "fresh-run.echo.json");
  const line = textOf(find((node) => node.props?.className === "cost-receipt-line"));
  assert.match(line, /list-price estimate/, "the opened file shows its cost line");
  assert.match(line, /not new spend/, "an opened file's cost line says it is the original run's, not new spend");
});
// 5. A saved run that finished loading after a live run started orphaned that run (selectBackup called acceptResult
// without aborting activeRequest): the paid stream kept going with no Cancel button. Repro on a slow network: click
// "3-second goldfish memory" under MORE SAVED RUNS, then at once type another claim and press Enter.
await plainCheck("a saved run that opens over a live run cancels the live run", async () => {
  await open("/");
  harness.traceDelayMs = 2_000;
  harness.paidDelayMs = 30_000;
  harness.phase = "user";
  nodes(tree).find((node) => node.type === "button" && textOf(node).startsWith("3-second goldfish memory")).props.onClick();
  await run();
  claimBox().props.onChange({ target: { value: "Goldfish remember things for months, not seconds" } });
  await run();
  find((node) => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await run(5_000);
  const live = paidRequests().find((request) => request.path === "/api/analyze");
  assert.ok(live, "the live run was sent");
  assert.match(textOf(tree), /SAVED LIVE RUN/, "the saved goldfish run opened after the live run started");
  assert.equal(live.signal?.aborted, true, "the live run in flight is cancelled when a saved run replaces it on screen");
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 3, offline links: public/sw.js runs in a sandbox with a fake Cache Storage and a fake network (no browser, no
// network) through install, activate and fetch: a fresh install, an upgrade from a v8 worker that stored every page as
// "/", a partly failed install, offline navigations to known and unknown addresses, and a rebuild. Static checks tie
// its precache lists to the routes (sitemap.ts, src/app/*/page.tsx) and the bundled traces, and git history to its
// cache version. Limits: the fake caches ignore Vary and quota, there is no HTTP cache, and a browser's update timing
// (when it fetches sw.js, other tabs) is not modelled; smoke:ui runs the real worker in Chrome.
const SW_ORIGIN = harness.origin;
class FakeCacheStorage {
  constructor() { this.stores = new Map(); }
  static keyOf(request) { return new URL(typeof request === "string" ? request : request.url, SW_ORIGIN).href; }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name);
    return {
      put: async (request, response) => { store.set(FakeCacheStorage.keyOf(request), { body: await response.clone().text(), status: response.status, headers: [...response.headers] }); },
      match: async (request) => { const hit = store.get(FakeCacheStorage.keyOf(request)); return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined; },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (request) => store.delete(FakeCacheStorage.keyOf(request)),
    };
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
  async has(name) { return this.stores.has(name); }
  async match(request) {
    for (const name of this.stores.keys()) { const hit = await (await this.open(name)).match(request); if (hit) return hit; }
    return undefined;
  }
  /** The addresses a cache holds, as paths. */
  entries(name) { return [...(this.stores.get(name)?.keys() ?? [])].map((url) => url.slice(SW_ORIGIN.length)); }
  async body(name, address) { return (await (await this.open(name)).match(address))?.text(); }
}
/** A production build: each page's HTML names a shared script, a stylesheet and its own chunk, as Next's does. */
function fakeBuild(id, { pages = ["/", "/how", "/explore", "/anywhere"], broken = [] } = {}) {
  const chunk = (page) => `/_next/static/chunks/${id}-${page === "/" ? "home" : page.slice(1)}.js`;
  const routes = new Map();
  for (const page of pages) {
    routes.set(page, { status: 200, type: "text/html; charset=utf-8", body: `<!DOCTYPE html><html><head><link rel="icon" href="/icon.svg?icon.${id}.svg" sizes="any" type="image/svg+xml"/><link rel="stylesheet" href="/_next/static/css/${id}.css"><script src="/_next/static/chunks/${id}-main.js" async=""></script><script src="${chunk(page)}" async=""></script></head><body>page ${page} of build ${id}</body></html>` });
    routes.set(chunk(page), { status: 200, type: "application/javascript", body: `/* ${chunk(page)} */` });
  }
  routes.set(`/_next/static/css/${id}.css`, { status: 200, type: "text/css", body: "body{}" });
  routes.set(`/_next/static/chunks/${id}-main.js`, { status: 200, type: "application/javascript", body: "/* main */" });
  for (const trace of fs.readdirSync(path.join(root, "public", "demo-traces")).filter((name) => name.endsWith(".echo.json"))) routes.set(`/demo-traces/${trace}`, { status: 200, type: "application/json", body: "{}" });
  routes.set("/manifest.webmanifest", { status: 200, type: "application/manifest+json", body: "{}" });
  routes.set("/icon.svg", { status: 200, type: "image/svg+xml", body: "<svg/>" });
  routes.set("/badge/americans-check-phones-96-times", { status: 200, type: "image/svg+xml", body: "<svg>badge</svg>" });
  routes.set("/old-address", { status: 200, type: "text/html", body: "<html>redirect target</html>", redirected: true });
  routes.set("/broken", { status: 500, type: "text/html", body: "<html>server error</html>" });
  for (const address of broken) routes.set(address, { status: 500, type: "text/plain", body: "error" });
  return { id, routes };
}
/** Runs a worker's source with `caches` and a network that serves `net.build`, or fails while `net.online` is false. */
function serviceWorker(source, caches, net) {
  const listeners = {};
  const fakeFetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url, SW_ORIGIN);
    if (!net.online) throw new TypeError("Failed to fetch");
    const route = net.build.routes.get(url.pathname) ?? { status: 404, type: "text/html", body: "<html>not found</html>" };
    const response = new Response(route.body, { status: route.status, headers: { "content-type": route.type } });
    if (route.redirected) Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  const self = {
    location: new URL("/sw.js", SW_ORIGIN),
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); },
    skipWaiting: async () => { net.skipWaiting = true; },
    clients: { claim: async () => { net.claimed = true; } },
  };
  vm.runInNewContext(source, { self, caches, fetch: fakeFetch, Response, Request, Headers, URL, console });
  const lifecycle = async (type) => {
    const waits = [];
    for (const handler of listeners[type] ?? []) handler({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  };
  return {
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    /** A request as the page makes it: the worker's answer, or undefined when it leaves the request to the browser. */
    async fetch(address, { mode = "no-cors", method = "GET", headers = {} } = {}) {
      let answer;
      const event = { request: { url: new URL(address, SW_ORIGIN).href, method, mode, headers: new Headers(headers) }, respondWith: (promise) => { answer = promise; }, waitUntil() {} };
      for (const handler of listeners.fetch ?? []) handler(event);
      if (!answer) return undefined;
      const response = await answer;
      // The worker writes the page's copy without awaiting it; let that land.
      for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
      return response;
    },
  };
}
const swSource = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
/** A top-level constant of a worker's source (CACHE_NAME, DEMO_TRACES, OFFLINE_PAGES), read by running it inert. */
const swConst = (source, name) => {
  const context = { self: { location: new URL("/sw.js", SW_ORIGIN), addEventListener() {} }, URL };
  // Through JSON, so arrays are this realm's (assert's deep equality compares prototypes).
  vm.runInNewContext(`${source}\n;globalThis.__value = typeof ${name} === "undefined" ? undefined : JSON.stringify(${name});`, context);
  return context.__value === undefined ? undefined : JSON.parse(context.__value);
};
const swCacheName = swConst(swSource, "CACHE_NAME");
const swPages = swConst(swSource, "OFFLINE_PAGES") ?? [swConst(swSource, "APP_SHELL")];
const bundledTraces = fs.readdirSync(path.join(root, "public", "demo-traces")).filter((name) => name.endsWith(".echo.json")).map((name) => `/demo-traces/${name}`).sort();
/** "/how @ A" for build A's /how page, "network error", or "not handled" when the browser gets the request. */
const pageText = async (response) => (response ? (await response.text()).match(/page (\S+) of build ([A-Za-z0-9]+)/)?.slice(1).join(" @ ") ?? (response.type === "error" ? "network error" : "other") : "not handled");
const sitemapPages = [...fs.readFileSync(path.join(root, "src", "app", "sitemap.ts"), "utf8").matchAll(/at\("(\/[^"?#]*)"\)/g)].map((match) => match[1]);
/** A worker installed and activated from build A, online. */
const installedWorker = async (source = swSource, build = fakeBuild("A")) => {
  const caches = new FakeCacheStorage();
  const net = { online: true, build };
  const sw = serviceWorker(source, caches, net);
  await sw.install();
  await sw.activate();
  return { caches, net, sw };
};

await plainCheck("public/sw.js names its cache echo-shell-vN and precaches exactly the bundled traces", async () => {
  assert.match(String(swCacheName), /^echo-shell-v\d+$/, "CACHE_NAME is echo-shell-v<number> (the workbench's readiness panel looks for echo-shell-)");
  assert.deepEqual([...(swConst(swSource, "DEMO_TRACES") ?? [])].sort(), bundledTraces, "DEMO_TRACES lists exactly the files in public/demo-traces");
  const slots = fs.readFileSync(path.join(root, "src", "app", "demo-slots.ts"), "utf8");
  const captured = [...new Set([...slots.matchAll(/capturedTrace: "([^"]+)"/g)].map((match) => match[1]))];
  assert.ok(captured.length >= 4, "demo-slots.ts names its captured traces");
  assert.deepEqual(captured.filter((trace) => !bundledTraces.includes(trace)), [], "every slot's and backup's capturedTrace is a bundled trace the worker precaches");
});
await plainCheck("every page public/sw.js precaches is a real route listed in sitemap.ts", async () => {
  for (const page of swPages) {
    const file = path.join(root, "src", "app", ...page.split("/").filter(Boolean), "page.tsx");
    assert.ok(fs.existsSync(file), `${page} has a page (${path.relative(root, file)})`);
    assert.ok(sitemapPages.includes(page), `${page} is in sitemap.ts`);
  }
});
await plainCheck("public/sw.js's cache version was bumped in every commit that changed its code", async () => {
  // A comment does not change what the worker does; any other change needs a new echo-shell-vN, so the new worker
  // installs a fresh cache and its activate deletes the old one. Without git history (a tarball), this is skipped.
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let commits;
  try { commits = git("log", "--format=%H", "--", "public/sw.js").split("\n").filter(Boolean); } catch { return; }
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s+\/\/[^"'`\n]*$/gm, "").replace(/\s+/g, " ").trim();
  const versions = [{ label: "the working tree", source: swSource }, ...commits.map((commit) => ({ label: commit.slice(0, 7), source: git("show", `${commit}:public/sw.js`) }))];
  assert.ok(versions.length > 1 || !commits.length, "git history of public/sw.js was read");
  for (const [index, current] of versions.entries()) {
    let before = null;
    if (index === 0) before = versions[1] ?? null;
    else try { before = { source: git("show", `${commits[index - 1]}^:public/sw.js`) }; } catch { before = null; }
    if (!before || code(before.source) === code(current.source)) continue;
    assert.notEqual(swConst(current.source, "CACHE_NAME"), swConst(before.source, "CACHE_NAME"), `${current.label} changed sw.js's code but kept CACHE_NAME ${swConst(current.source, "CACHE_NAME")}`);
  }
});
await plainCheck("a fresh install caches each offline page under its own address with every file it names", async () => {
  const { caches, net, sw } = await installedWorker();
  assert.deepEqual(await caches.keys(), [swCacheName], "one cache, the current version");
  for (const page of swPages) {
    const html = await caches.body(swCacheName, page);
    assert.match(html ?? "", new RegExp(`page ${page} of build A`), `${page} is cached under its own address`);
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(caches.entries(swCacheName).includes(asset), `${page}'s ${asset} is cached`);
  }
  for (const trace of bundledTraces) assert.ok(caches.entries(swCacheName).includes(trace), `${trace} is cached`);
  net.online = false;
  for (const [address, expected] of [["/", "/ @ A"], ["/?slot=02", "/ @ A"], ["/?trace=goldfish-3-second-memory", "/ @ A"], ["/how", "/how @ A"], ["/how/", "/how @ A"], ["/explore?from=how", "/explore @ A"], ["/nope", "/ @ A"]]) {
    assert.equal(await pageText(await sw.fetch(address, { mode: "navigate" })), expected, `offline, ${address} opens ${expected}`);
  }
  for (const trace of bundledTraces) assert.equal((await sw.fetch(trace))?.status, 200, `offline, ${trace} loads`);
  // Next names the tab icon with a hash query (/icon.svg?icon.<hash>.svg); offline it must load, not fail on every page.
  assert.equal((await sw.fetch("/icon.svg?icon.A.svg"))?.status, 200, "offline, the tab icon as the page names it loads");
  assert.equal(await sw.fetch("/?_rsc=1x2y", { headers: { RSC: "1" } }), undefined, "RSC data is never answered from the page cache");
  assert.equal(await sw.fetch("/api/analyze", { method: "POST" }), undefined, "a POST is left to the browser");
  assert.equal(await sw.fetch("/api/analyze"), undefined, "/api is never cached");
  // Online again on a new build: a visit to /how refreshes /how, never "/" (v8's bug), and errors, redirects,
  // non-pages and 404s never land.
  net.online = true;
  net.build = fakeBuild("B");
  const notPages = ["/broken", "/old-address", "/badge/americans-check-phones-96-times", "/nope"];
  for (const address of ["/how", ...notPages]) await sw.fetch(address, { mode: "navigate" });
  assert.match(await caches.body(swCacheName, "/how"), /page \/how of build B/, "an online visit refreshes /how's copy");
  assert.match(await caches.body(swCacheName, "/"), /page \/ of build A/, "an online visit to /how leaves the app shell alone");
  for (const address of notPages) assert.ok(!caches.entries(swCacheName).includes(address), `${address} (an error, a redirect, an image or a 404) is not cached`);
});
await plainCheck("an upgrade from a v8 worker deletes v8's cache, whose \"/\" could hold another page", async () => {
  const caches = new FakeCacheStorage();
  await (await caches.open("echo-shell-v8")).put("/", new Response("<html>page /how of build OLD</html>", { headers: { "content-type": "text/html" } }));
  await (await caches.open("another-app")).put("/x", new Response("x"));
  const net = { online: true, build: fakeBuild("A") };
  const sw = serviceWorker(swSource, caches, net);
  await sw.install();
  await sw.activate();
  assert.deepEqual((await caches.keys()).sort(), ["another-app", swCacheName].sort(), "activate deletes every older echo-shell-* cache and nothing else");
  assert.ok(net.skipWaiting && net.claimed, "the new worker takes over open tabs at once (skipWaiting, clients.claim)");
  net.online = false;
  assert.equal(await pageText(await sw.fetch("/", { mode: "navigate" })), "/ @ A", "offline, / opens the app, not the page v8 stored as /");
});
await plainCheck("a partly failed install caches no page without the files it needs", async () => {
  const caches = new FakeCacheStorage();
  const sw = serviceWorker(swSource, caches, { online: true, build: fakeBuild("A", { broken: ["/_next/static/chunks/A-explore.js"] }) });
  // (The worker's errors come from its sandbox's realm, so match the message, not the class.)
  await assert.rejects(sw.install(), (error) => /Could not cache/.test(error?.message), "the install fails, so the browser keeps the old worker (or none)");
  assert.deepEqual(swPages.filter((page) => caches.entries(swCacheName).includes(page)), [], "pages are stored last, so none is cached without its scripts");
});

// Review round 8 (11/13), the offline worker (public/sw.js, the feature agent's file).
// A. /anywhere was in sitemap.ts but not precached: offline, a browser that never opened it online got the workbench at
// /anywhere. Fixed on main 11/13 (33298f9, cache v10); now a plain check.
await plainCheck("every page in sitemap.ts is precached by public/sw.js, so each opens offline", async () => {
  assert.deepEqual(sitemapPages.filter((page) => !swPages.includes(page)), [], "every page in sitemap.ts is precached");
});
// B. EXPECTED FAILURE, deferred by the coordinator until after the freeze: the cache only grows. Hashed /_next/static files are added on every online visit and removed only when
// CACHE_NAME changes, and sw.js does not change with a build, so every rebuild's scripts stay. Repro: npm run build,
// npm start, open /; change any src file, build, start, open / again: DevTools > Application > Cache Storage >
// echo-shell-v10 holds both builds' chunks, and the readiness panel's "Cached · N app files" climbs. The feature agent's
// fix (9fa340a on branch worktree-agent-afae4bf90c72a0ee6, cache v11) was held back as too risky before the freeze.
// The sandbox's caches have delete(), so a pruning worker can pass here.
await expectedFailure("deferred by the coordinator until after the freeze: public/sw.js drops /_next/static files that no cached page names (the pruning commit 9fa340a is on branch worktree-agent-afae4bf90c72a0ee6)", async () => {
  const { caches, net, sw } = await installedWorker();
  net.build = fakeBuild("B");
  // After a rebuild, one online visit to each offline page, loading the files it names.
  for (const page of swPages) {
    const html = await (await sw.fetch(page, { mode: "navigate" })).text();
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) await sw.fetch(asset);
  }
  const stale = caches.entries(swCacheName).filter((address) => address.startsWith("/_next/static/") && /\/A[-.]/.test(address));
  assert.deepEqual(stale, [], "no file of the replaced build stays once every cached page is the new build's");
});

// Review round 8 (11/13), main's round-3 features: the page breakdown line, slide 4's grouping, the failed run's
// spend line and the readiness panel. All plain checks now (C and D were fixed on main 11/13).
const { pageBreakdownLine } = load("../src/app/trace-view.ts");
const BREAKDOWN = /^(\d+) pages? = (\d+) root pages? \((\d+) independent origins?(?:; pages published together count once)?\) \+ (\d+) confirmed cop(?:y|ies) \+ (\d+) unclear$/;
const bundledFiles = bundledTraces.map((trace) => JSON.parse(fs.readFileSync(path.join(root, "public", trace), "utf8")));
/** The saved phones run with every page unclear: no root, no copy, an answer that cites nothing. */
const allUnclear = (() => {
  const analysis = structuredClone(phonesFile.analysis);
  for (const page of analysis.pages) page.judgment = { ...page.judgment, kind: "unclear", parentId: null };
  Object.assign(analysis, { roots: [], verifiableRoots: [], answerSourceIds: [], answer: "Echo found no independent root for this claim.", summary: { ...analysis.summary, independentOrigins: 0, verifiableOrigins: 0, echoPercentage: 0 } });
  for (const key of ["answerStatements", "answerReviews", "coPublishedRootGroups", "copyHunt"]) delete analysis[key];
  return analysis;
})();
/** Types a claim and presses Trace sources; /api/analyze answers with `events` (a stream of [event, data]). */
const traceWithAnswer = async (claimText, events) => {
  harness.analyzeEvents = events;
  harness.phase = "user";
  claimBox().props.onChange({ target: { value: claimText } });
  await run();
  find((node) => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await run(5_000);
};
/** Starts Present mode and presses Next until the slide labelled `slideLabel` shows (null: stay on slide 1). */
const present = async (slideLabel = null) => {
  find((node) => node.type === "button" && node.props["aria-label"] === "Start judge-facing presentation").props.onClick();
  await run();
  if (!slideLabel) return null;
  for (let step = 0; step < 8 && !find((node) => node.type === "article" && node.props["aria-label"] === slideLabel); step += 1) {
    nodes(tree).find((node) => node.type === "button" && textOf(node) === "Next →" && !node.props.disabled)?.props.onClick();
    await run(1_000);
  }
  return find((node) => node.type === "article" && node.props["aria-label"] === slideLabel);
};
const textOfClass = (className) => textOf(find((node) => node.props?.className === className));

await plainCheck("the page breakdown adds up on every bundled run, and reads as DEMO_DAY.md says on the phones run", async () => {
  for (const file of bundledFiles) {
    const line = pageBreakdownLine(file.analysis);
    const match = line.match(BREAKDOWN);
    assert.ok(match, `${file.analysis.claim}: “${line}” has the breakdown's form`);
    const [total, rootPages, origins, copies, unclear] = match.slice(1).map(Number);
    assert.equal(rootPages + copies + unclear, total, `${file.analysis.claim}: “${line}” adds up`);
    assert.equal(origins, file.analysis.summary.independentOrigins, `${file.analysis.claim}: the origins match the verdict`);
  }
  assert.equal(pageBreakdownLine(phonesFile.analysis), "13 pages = 3 root pages (2 independent origins; pages published together count once) + 4 confirmed copies + 6 unclear");
});
await plainCheck("the page breakdown on odd traces: no root, a co-published group naming a page the trace dropped", async () => {
  assert.equal(pageBreakdownLine(allUnclear), "13 pages = 0 root pages (0 independent origins) + 0 confirmed copies + 13 unclear");
  const dropped = structuredClone(phonesFile.analysis);
  dropped.coPublishedRootGroups = dropped.coPublishedRootGroups.map((group) => [...group, "page-not-in-trace"]);
  assert.equal(pageBreakdownLine(dropped), pageBreakdownLine(phonesFile.analysis), "a group member missing from the pages changes nothing");
});
await plainCheck("a rehearsal fixture shows no page breakdown, on the result or on slide 1", async () => {
  await open("/");
  await openTraceFile(makePortableTrace(cloneDemoAnalysis("brain")), "rehearsal.echo.json");
  assert.match(textOf(tree), /ILLUSTRATIVE/, "the rehearsal opened");
  assert.equal(find((node) => node.props?.className === "page-breakdown-line"), null, "no breakdown under a rehearsal's verdict");
  await present();
  assert.ok(find((node) => node.props?.className?.startsWith?.("stage-presentation")), "Present mode opened");
  assert.equal(find((node) => node.props?.className === "stage-breakdown-line"), null, "no breakdown on a rehearsal's slide 1");
});
await plainCheck("a fresh run with no root: the breakdown says 0 root pages and slide 5 says no confirmed root", async () => {
  await open("/");
  await traceWithAnswer("Goldfish remember things for months, not seconds", [["result", { ...allUnclear, claim: "Goldfish remember things for months, not seconds", createdAt: "2026-11-14T18:00:00.000Z", costReceipt: receipt }]]);
  assert.match(textOf(tree), /FRESH LIVE TRACE/, "the streamed result opened as a fresh run");
  assert.equal(textOfClass("page-breakdown-line"), "13 pages = 0 root pages (0 independent origins) + 0 confirmed copies + 13 unclear");
  const slide = await present("Origin review");
  assert.ok(slide, "slide 5 (Check the origins) opened");
  assert.match(textOf(slide), /No confirmed root in this trace/, "slide 5 says there is no root");
});
await plainCheck("slide 5 keeps one item per origin when a co-published group names a page the trace lacks", async () => {
  await open("/");
  const result = structuredClone(phonesFile.analysis);
  result.coPublishedRootGroups = result.coPublishedRootGroups.map((group) => [...group, "page-not-in-trace"]);
  await traceWithAnswer("Phones are checked 96 times a day by Americans", [["result", { ...result, claim: "Phones are checked 96 times a day by Americans", createdAt: "2026-11-14T18:00:00.000Z" }]]);
  const slide = await present("Origin review");
  assert.ok(slide, "slide 5 (Check the origins) opened");
  const items = nodes(slide).filter((node) => node.type === "li");
  assert.equal(items.length, result.summary.independentOrigins, "one item per origin");
  assert.doesNotMatch(textOf(slide), /page-not-in-trace/, "the missing page's id is never shown");
  assert.match(textOf(slide), /published together, counted as one origin/, "the group's kept pages still share an item");
});
// S3-8 (QA round 3): after a failed Check these sources run, Try again repeated the old run while the panel showed
// edited links and sentence. It now reruns what the panel shows, as the panel's own button would.
await plainCheck("Try again after a failed Check these sources run reruns the panel as it reads now", async () => {
  const [first, second] = ["https://a.example/one", "https://b.example/two"];
  await open(`/?claim=${encodeURIComponent("Americans check their phones 96 times a day")}&urls=${encodeURIComponent(`${first} ${second}`)}`);
  harness.analyzeEvents = [["error", { code: "CLAUDE_OVERLOADED", message: "Claude is busy." }]];
  harness.phase = "user";
  nodes(tree).find((node) => node.type === "button" && /^Check \d+ sources?/.test(textOf(node))).props.onClick({ preventDefault() {} });
  await run(5_000);
  const sentBodies = () => harness.requests.filter((request) => request.method === "POST" && request.path === "/api/analyze").map((request) => JSON.parse(request.body ?? "{}"));
  assert.equal(sentBodies().length, 1, "the panel's button sent one run");
  // Edit the panel: drop the second link from the text and change the sentence.
  find((node) => node.type === "textarea" && node.props.id === "source-check-text").props.onChange({ target: { value: first } });
  await run();
  find((node) => node.type === "input" && node.props.id === "source-check-claim").props.onChange({ target: { value: "Americans look at their phones 96 times daily" } });
  await run();
  const retry = nodes(tree).find((node) => node.type === "button" && textOf(node) === "Try again");
  assert.ok(retry, "the failed run offers Try again");
  retry.props.onClick();
  await run(5_000);
  const bodies = sentBodies();
  assert.equal(bodies.length, 2, "Try again sent one more run");
  assert.deepEqual({ claim: bodies[1].claim, urls: bodies[1].urls }, { claim: "Americans look at their phones 96 times daily", urls: [first] }, "Try again sends the panel's links and sentence as they read now");
  // A sentence too short to check: Try again is not offered (the panel's own button is disabled too).
  find((node) => node.type === "input" && node.props.id === "source-check-claim").props.onChange({ target: { value: "short" } });
  await run();
  assert.equal(nodes(tree).find((node) => node.type === "button" && textOf(node) === "Try again"), undefined, "no Try again for a sentence the panel would not send");
});
// The saved Check these sources run (demo-slots.ts SAVED_SOURCE_CHECK): its button in the panel and its chip under MORE
// SAVED RUNS open the bundled result and send nothing paid; a failed or stalled run of the same links (any order,
// numbering, http/www) offers it, and one of other links does not.
{
  const slots = fs.readFileSync(path.join(root, "src", "app", "demo-slots.ts"), "utf8");
  const savedTrace = slots.match(/savedTrace: "([^"]+)"/)?.[1];
  const savedUrls = [...(slots.slice(slots.indexOf("SAVED_SOURCE_CHECK")).match(/urls: \[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const savedFile = savedTrace ? JSON.parse(fs.readFileSync(path.join(root, "public", savedTrace), "utf8")) : null;
  const savedPath = savedTrace ?? "/demo-traces/missing";
  const fetchedSaved = () => harness.requests.some((request) => request.method === "GET" && request.path === savedPath);
  const savedShown = () => /SAVED LIVE RUN/.test(textOf(tree)) && /5 supplied links → 1 independent origin/.test(textOf(tree));
  const buttonText = (text) => nodes(tree).find((node) => node.type === "button" && textOf(node).trim().startsWith(text));
  await plainCheck("SAVED_SOURCE_CHECK names a bundled, precached Check these sources run of exactly its links", async () => {
    assert.ok(savedTrace && bundledTraces.includes(savedTrace), `${savedTrace} is a bundled trace the worker precaches`);
    assert.ok(savedFile?.analysis?.sourceCheck, "it is a Check these sources run");
    assert.deepEqual(savedFile.analysis.sourceCheck.urls, savedUrls, "SAVED_SOURCE_CHECK.urls are its supplied links, in order");
    assert.equal(savedFile.analysis.claim, slots.slice(slots.indexOf("SAVED_SOURCE_CHECK")).match(/claim: "([^"]+)"/)?.[1], "and its sentence");
  });
  await plainCheck("the saved-check button in the panel and its chip under MORE SAVED RUNS open the saved run, sending nothing paid", async () => {
    for (const where of ["panel", "chip"]) {
      await open(where === "panel" ? `/?urls=${encodeURIComponent("https://a.example/one")}` : "/");
      harness.phase = "user";
      const button = where === "panel"
        ? nodes(find((node) => node.type === "section" && node.props.id === "source-check")).find((node) => node.type === "button" && textOf(node).trim().startsWith("Saved check: 5 links → 1 origin"))
        : nodes(tree).find((node) => node.type === "button" && /saved-check-chip/.test(node.props.className ?? ""));
      assert.ok(button, `the ${where} offers the saved check`);
      button.props.onClick({ preventDefault() {} });
      await run(5_000);
      assert.deepEqual(paidRequests(), [], `pressing the ${where}'s saved check sends no paid request`);
      assert.ok(fetchedSaved() && savedShown(), `the ${where}'s saved check opens the saved run (fetched ${fetchedSaved()})`);
      assert.match(textOf(tree), /captured Nov 13, 2026/, "tagged with its capture date");
    }
  });
  await plainCheck("a failed Check these sources run of the saved check's links offers the saved run; other links do not", async () => {
    // The same five pages, reordered, renumbered and one written as http without www: still the saved check's links.
    const reordered = [savedUrls[4], savedUrls[0].replace("https://www.", "http://"), savedUrls[2], savedUrls[1], savedUrls[3]];
    const nums = "5,1,3,2,4";
    for (const [label, urls, offered] of [["the same links", reordered, true], ["four of them", savedUrls.slice(0, 4), false], ["other links", ["https://a.example/one", "https://b.example/two"], false]]) {
      await open(`/?claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent(urls.join(" "))}${urls.length === 5 ? `&nums=${nums}` : ""}`);
      harness.analyzeEvents = [["error", { code: "CLAUDE_OVERLOADED", message: "Claude is busy." }]];
      harness.phase = "user";
      nodes(tree).find((node) => node.type === "button" && /^Check \d+ sources?/.test(textOf(node))).props.onClick({ preventDefault() {} });
      await run(5_000);
      assert.equal(paidRequests().length, 1, `${label}: the panel's button sent one run`);
      const fallback = buttonText("Open the saved run of these links");
      assert.equal(Boolean(fallback), offered, `${label}: the failed run ${offered ? "offers" : "does not offer"} the saved run of these links`);
      assert.equal(buttonText("Open the saved run of this claim"), undefined, `${label}: a sources run never offers the search run of its claim`);
      if (!fallback) continue;
      fallback.props.onClick();
      await run(5_000);
      assert.equal(paidRequests().length, 1, "opening the saved run sends nothing more");
      assert.ok(fetchedSaved() && savedShown(), "it opens the saved run of these links");
    }
  });
  await plainCheck("a stalled Check these sources run of the saved check's links offers the saved run and cancels the live run", async () => {
    await open(`/?claim=${encodeURIComponent(CLAIM)}&urls=${encodeURIComponent(savedUrls.join(" "))}`);
    harness.paidDelayMs = 300_000;
    harness.phase = "user";
    buttonText("Check 5 sources").props.onClick({ preventDefault() {} });
    await run(60_000);
    const fallback = buttonText("Open the saved run instead");
    assert.ok(fallback, "after 40 s with no progress the stall note offers the saved run");
    fallback.props.onClick();
    await run(5_000);
    const live = paidRequests().filter((request) => request.path === "/api/analyze");
    assert.equal(live.length, 1, "one live run was sent, and nothing more");
    assert.equal(live[0].signal?.aborted, true, "the stalled run is cancelled");
    assert.ok(fetchedSaved() && savedShown(), "the saved run of these links opens");
  });
}
// QA round 5 (S3-2): the home line said "Provider keys configured" and the cap line "Echo API (Claude + Tavily)" even
// when every search went through Telem, or when Telem was chosen with a missing or malformed key. The status GET now
// names the router (a name only) and the line shows it; a misconfigured router reads as a plain warning.
await plainCheck("the claim box names the search router and warns when Telem's key is missing or malformed", async () => {
  // 11/13: one cap per provider (daily-budget.ts), Telem's with its running total against the prepaid credit.
  const providers = { claude: { capUsd: 50, spentUsd: 0.31, reservedUsd: 0 }, tavily: { capUsd: 5, spentUsd: 0.08, reservedUsd: 0 }, telem: { capUsd: 3, spentUsd: 0.42, reservedUsd: 0 } };
  const base = { anthropicConfigured: true, tavilyConfigured: true, copyHuntEnabled: true, liveRunsLocked: false, dailyBudget: { capUsd: 50, spentUsd: 0.81, reservedUsd: 0, available: true, storage: "local", providers, telem: { totalUsd: 1.1, creditUsd: 20 } } };
  const note = () => textOf(find((node) => node.props?.className?.startsWith?.("key-note")));
  await open("/", { config: { ...base, searchRouter: "telem" } });
  assert.match(note(), /^Provider keys configured · Search: Telem · Slot 03 always fresh/, "Telem routing is named");
  assert.match(note(), /Telem today \$0\.42 \/ \$3\.00 · total \$1\.10 of \$20 credit · Claude \$0\.31 \/ \$50\.00 · Tavily \$0\.08 \/ \$5\.00 · local ledger · resets midnight Pacific$/, "the cap line leads with Telem's own cap and its running total");
  await open("/", { config: { ...base, searchRouter: "telem", dailyBudget: { ...base.dailyBudget, providers: { ...providers, telem: { capUsd: 3, spentUsd: 2.99, reservedUsd: 0.02 } } } } });
  assert.match(note(), /Telem today \$2\.99 \(\+\$0\.02 reserved\) \/ \$3\.00 · total \$1\.10 of \$20 credit · Telem cap reached: searches use Tavily until midnight · Claude/, "Telem's cap reached sends searches to Tavily, it does not pause live runs");
  assert.doesNotMatch(note(), /live runs paused/, "a Telem cap alone pauses nothing");
  await open("/", { config: { ...base, searchRouter: "tavily" } });
  assert.match(note(), /^Provider keys configured · Search: Tavily · /, "Tavily routing is named");
  assert.match(note(), /Claude today \$0\.31 \/ \$50\.00 · Tavily \$0\.08 \/ \$5\.00 · local ledger · resets midnight Pacific$/, "the cap line names Claude's and Tavily's caps, no Telem");
  await open("/", { config: { ...base, searchRouter: "tavily", dailyBudget: { ...base.dailyBudget, providers: { ...providers, tavily: { capUsd: 5, spentUsd: 5, reservedUsd: 0 } } } } });
  assert.match(note(), /Tavily \$5\.00 \/ \$5\.00 · Tavily cap reached, live runs paused \(saved runs still open\)/, "Tavily's cap reached pauses live runs");
  // An older server sends only the combined figures: no cap is named, nothing breaks.
  await open("/", { config: { ...base, searchRouter: "tavily", dailyBudget: { capUsd: 2, spentUsd: 0.4, reservedUsd: 0, available: true, storage: "local" } } });
  assert.match(note(), /Echo API today \(Claude \+ search\): \$0\.40 spent · local ledger/, "an older server's combined figure still reads");
  await open("/", { config: { ...base, searchRouter: "misconfigured" } });
  assert.doesNotMatch(note(), /Provider keys configured/, "a misconfigured router is not called configured");
  assert.match(note(), /Search is set to Telem, but its key is missing or is not a Telem key · fix the key, or set ECHO_SEARCH_ROUTER=tavily in \.env\.local and restart · saved runs still open/, "it says what to do");
  // QA round 6 (S3-2): the cap line beside that warning read "Echo API (Claude + Tavily)", naming a search provider
  // the warning says is not set up. It names neither router until the key is fixed.
  assert.match(note(), /Echo API today \(Claude \+ search\): \$0\.81 spent/, "the cap line of a misconfigured router names no search provider");
  // The server side: a name only, from the environment; Tavily's cap reads as page reading when Telem searches.
  const { searchRouterStatus } = load(path.join(root, "src", "lib", "echo", "telem.ts"));
  const { capWords } = load(path.join(root, "src", "lib", "echo", "daily-budget.ts"));
  const saved = { key: process.env.TELEM_API_KEY, router: process.env.ECHO_SEARCH_ROUTER };
  try {
    const status = (key, router) => {
      if (key === undefined) delete process.env.TELEM_API_KEY; else process.env.TELEM_API_KEY = key;
      if (router === undefined) delete process.env.ECHO_SEARCH_ROUTER; else process.env.ECHO_SEARCH_ROUTER = router;
      return [searchRouterStatus(), capWords("tavily")];
    };
    assert.deepEqual(status(undefined, undefined), ["tavily", "daily Tavily cap (searches and page reading)"], "no Telem key: Tavily");
    assert.deepEqual(status("tlm_abcdefghijk", undefined), ["telem", "daily Tavily cap (page reading)"], "a Telem key: Telem");
    assert.deepEqual(status("not-a-telem-key", undefined), ["misconfigured", "daily Tavily cap (page reading)"], "a malformed Telem key: misconfigured");
    assert.deepEqual(status(undefined, "telem"), ["misconfigured", "daily Tavily cap (page reading)"], "ECHO_SEARCH_ROUTER=telem with no key: misconfigured");
    assert.deepEqual(status("not-a-telem-key", "tavily"), ["tavily", "daily Tavily cap (searches and page reading)"], "ECHO_SEARCH_ROUTER=tavily wins");
    assert.equal(capWords("telem"), "daily Telem cap (searches)");
    assert.equal(capWords("claude"), "daily Claude cap");
  } finally {
    if (saved.key === undefined) delete process.env.TELEM_API_KEY; else process.env.TELEM_API_KEY = saved.key;
    if (saved.router === undefined) delete process.env.ECHO_SEARCH_ROUTER; else process.env.ECHO_SEARCH_ROUTER = saved.router;
  }
});
// QA round 5 (S3-9): a screen reader heard "5 pages found … 1 unresolved relationship" for a Check these sources result
// (it searched nothing) and "unresolved" for a search result. It hears "links read" and "unclear" now.
await plainCheck("the result's screen-reader status says links read for supplied links and unclear relationships", async () => {
  const status = () => textOf(nodes(tree).find((node) => node.props?.role === "status" && /Trace complete\./.test(textOf(node))) ?? null);
  const v2 = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json"), "utf8")).analysis;
  await open("/");
  await traceWithAnswer(v2.claim, [["result", { ...v2, createdAt: "2026-11-14T18:00:00.000Z" }]]);
  assert.equal(status(), "Trace complete. 5 links read, 1 independent origin, 1 unclear relationship.", "a supplied-links result");
  const search = phonesFile.analysis;
  const unclear = search.pages.filter((page) => page.judgment.kind === "unclear").length;
  await open("/");
  await traceWithAnswer("Goldfish remember things for months, not seconds", [["result", { ...search, claim: "Goldfish remember things for months, not seconds", createdAt: "2026-11-14T18:00:00.000Z" }]]);
  assert.equal(status(), `Trace complete. ${search.summary.totalPages} pages found, ${search.summary.independentOrigins} independent origins, ${unclear} unclear relationships.`, "a search result");
});
// QA round 5 (S3-5): a Telem outage (TELEM_ERROR, Telem's 503) or rate limit read "This run needs another try" with no
// Try again button. Both now offer it, and Try again stays the only thing that sends a run after the failure.
await plainCheck("a Telem error or rate limit offers Try again, which sends exactly one new run", async () => {
  for (const [code, message] of [["TELEM_ERROR", "Telem could not run this search (503)."], ["TELEM_RATE_LIMIT", "Telem is rate-limiting this key for the next 42 s. Echo does not retry: wait a minute and run it again."]]) {
    await open("/");
    await traceWithAnswer("Goldfish remember things for months, not seconds", [["progress", { stage: "search", label: "Searching", detail: "" }], ["error", { code, message }]]);
    assert.match(textOf(find((node) => node.props?.className === "error-banner")), /This run needs another try/, `${code}: the card asks for another try`);
    const posts = () => harness.requests.filter((request) => request.method === "POST" && request.path === "/api/analyze").length;
    const before = posts();
    harness.phase = "idle";
    await run(2_000);
    assert.equal(posts(), before, `${code}: nothing is sent while the failure card shows`);
    const retry = nodes(tree).find((node) => node.type === "button" && textOf(node) === "Try again");
    assert.ok(retry, `${code}: the card offers Try again`);
    harness.analyzeEvents = [["error", { code, message }]];
    harness.phase = "user";
    retry.props.onClick();
    await run(5_000);
    assert.equal(posts(), before + 1, `${code}: Try again sends exactly one new run`);
    assert.equal(paidRequests().filter((request) => request.phase !== "user").length, 0, `${code}: no paid request without a click`);
  }
});
await plainCheck("a failed run's card says what it spent, and only that run's card", async () => {
  const claimText = "Goldfish remember things for months, not seconds";
  await open("/");
  await traceWithAnswer(claimText, [["progress", { stage: "search", label: "Searching", detail: "" }], ["error", { code: "CLAUDE_OVERLOADED", message: "Claude is busy.", costReceipt: receipt }]]);
  assert.match(textOfClass("error-spend"), /^This run spent ≈\$0\.19 before it stopped \(list-price estimate\)$/, "the card names the failed run's spend");
  // Try again; the second failure carries no receipt (a timeout), so the first run's figure must not stay.
  harness.analyzeEvents = [["error", { code: "TIMEOUT", message: "A provider request timed out. Try the claim again." }]];
  nodes(tree).find((node) => node.type === "button" && textOf(node) === "Try again").props.onClick();
  await run(5_000);
  assert.match(textOf(find((node) => node.props?.className === "error-banner")), /timed out/, "the second failure's card shows");
  assert.equal(find((node) => node.props?.className === "error-spend"), null, "no spend line from the earlier run");
  // A cache hit is a result, never a failure: no card, and the toolbar says the cost is the original run's.
  await open("/");
  await traceWithAnswer(claimText, [["result", { ...phonesFile.analysis, claim: claimText, createdAt: "2026-11-14T18:00:00.000Z", cacheHit: true, costReceipt: receipt }]]);
  assert.equal(find((node) => node.props?.className === "error-spend"), null, "a cache hit shows no failed-run spend");
  assert.match(textOfClass("cost-receipt-line"), /^Saved run: cost of the original run, not new spend/, "a cache hit's cost line is the original run's");
});
// C. A run that failed before anything was billed (Tavily refused the key, or every search failed) sends a receipt
// of $0, and the card said "This run spent ≈$0.00 before it stopped"; below a cent it also said $0.00. Fixed on main
// 11/13 (6e10b79): no line at $0, "under $0.01" below a cent. Now a plain check.
await plainCheck("a failed run billed nothing names no spend, and one billed under a cent says “under $0.01”", async () => {
  await open("/");
  await traceWithAnswer("Goldfish remember things for months, not seconds", [["error", { code: "TAVILY_AUTH", message: "Tavily rejected the API key.", costReceipt: new ReceiptDraft(0.008).finish() }]]);
  assert.match(textOf(find((node) => node.props?.className === "error-banner")), /Tavily rejected/, "the failure's card shows");
  assert.equal(find((node) => node.props?.className === "error-spend"), null, "a run that was billed nothing has no spend line");
  assert.doesNotMatch(textOf(tree), /spent ≈\$0\.00/, "a run that was billed nothing names no $0.00 spend");
  // Half a Tavily credit at $0.008 a credit: $0.004.
  const subCent = new ReceiptDraft(0.008);
  subCent.tavilyRequest("search", "basic", 0, 0.5);
  await open("/");
  await traceWithAnswer("Goldfish remember things for months, not seconds", [["error", { code: "TIMEOUT", message: "A provider request timed out. Try the claim again.", costReceipt: subCent.finish() }]]);
  assert.equal(textOfClass("error-spend"), "This run spent under $0.01 before it stopped (list-price estimate)", "a sub-cent run says “under $0.01”, not $0.00");
});
// D. The readiness panel counted a saved run as ready offline when its trace sat in any echo-shell cache, including
// the partial one a failed install leaves behind (the worker stores pages last, but the traces may already be in):
// "4 / 4 saved runs ready offline" beside "App shell: Not cached yet". Fixed on main 11/13 (efcac50); now a plain check.
await plainCheck("the readiness panel counts a saved run as ready offline only where the app shell is cached", async () => {
  const partial = new FakeCacheStorage();
  const sw = serviceWorker(swSource, partial, { online: true, build: fakeBuild("A", { broken: ["/_next/static/chunks/A-explore.js"] }) });
  await sw.install().catch(() => undefined);
  assert.ok(bundledTraces.every((trace) => partial.entries(swCacheName).includes(trace)) && !partial.entries(swCacheName).includes("/"), "the failed install left the traces but no app shell");
  const savedEnv = process.env.NODE_ENV;
  define("caches", partial);
  windowStub.caches = partial;
  process.env.NODE_ENV = "production";
  try {
    await open("/");
    const panel = textOf(find((node) => node.type === "details" && node.props.className === "offline-readiness"));
    assert.match(panel, /App shell\s*Not cached yet/, "the panel sees no app shell");
    assert.match(panel, /0 \/ 5 saved runs ready offline/, "with no app shell cached, no saved run (of the 5, the saved check too) is ready offline");
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
    delete windowStub.caches;
    delete globalThis.caches;
  }
});

// Put the globals back.
Module._resolveFilename = resolveFilename;
Module._load = moduleLoad;
for (const [name, descriptor] of Object.entries(saved)) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

for (const line of inventory) console.log(`  ok    ${line}`);
for (const message of failures.slice(0, 40)) console.log(`  FAIL  ${message}`);
if (failures.length > 40) console.log(`  …     ${failures.length - 40} more`);
if (failures.length) {
  console.log(`\nEcho links check failed: ${failures.length} way(s) a link or page could spend, or the check could not prove it cannot.`);
  process.exit(1);
}
assert.ok(opened >= 100, "the harness opened every link in every setup");
console.log(`Echo links check passed: ${paidCalls.length} paid fetches reachable only from a person's click, submit or key; ${opened} link openings (${links.length} links × ${Object.keys(SETUPS).length} setups: claim, slot, trace, urls, unknown parameters, extension and bookmarklet links) sent no paid request in two idle minutes; the four controls did; ${presented} odd trace files opened and presented (${slidesShown} slides) without an error. No network.`);
