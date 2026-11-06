# SPEC: pi-autoresearch as a multi-host package (Pi extension + Claude Code plugin/MCP server)

Status: APPROVED after adversarial review (see §8, which overrides earlier sections where they conflict). Target version: 2.0.0.
Baseline: v1.9.0, `extensions/pi-autoresearch/index.ts` (3142 lines), 87 tests passing via
`node --experimental-strip-types --test tests/*.test.mjs`.

## 0. Goal and non-goals

Goal: one repo/package that works as
(a) the existing Pi extension, **behaviour-identical**, all 87 tests unchanged and passing; and
(b) a Claude Code plugin whose tools come from an MCP server (current MCP spec via
`@modelcontextprotocol/sdk`, stdio transport, tools + resources), reusing `skills/` as-is.

Non-goals: no new features in the loop semantics; no change to `.auto/` file formats,
`log.jsonl` schema, hook contract, or tool names/params; no rewrite of logic that moves.

Hard rule for the Builder: **move code, don't rewrite it.** Every function moved to core keeps
its name, signature and body. Where a Pi dependency must be severed, inject it (parameter or
small interface), never re-implement the Pi behaviour differently.

## 1. Architecture

### 1.1 Proposed layout

```
src/core/                       host-agnostic, only node:* imports (no Pi, no MCP, no TypeBox)
  types.ts                      ASI, ExperimentResult, MetricDef, ExperimentState, RunDetails, LogDetails
  state.ts                      createExperimentState, cloneExperimentState, currentResults,
                                findBaselineMetric, findBestMetric, findBaselineRunNumber,
                                findBaselineSecondary, isBetter, loadStateFromJsonl (new, extracted)
  confidence.ts                 sortedMedian, computeConfidence
  metrics.ts                    METRIC_LINE_PREFIX, DENIED_METRIC_NAMES, parseMetricLines, inferMetricUnit
  format.ts                     commas, fmtNum, formatNum, formatElapsed
  config.ts                     AutoresearchConfig, readConfig, readMaxExperiments, resolveWorkDir,
                                validateWorkDir, canonicalPath, samePath
  paths.ts                      (moved from extensions/) sessionFilePath, ... + the six
                                autoresearchXxxPath aliases
  jsonl.ts                      (moved) + readJsonlLines, readLastRun, hasLoggedExperiment
  hooks.ts                      (moved) + buildSessionSnapshot, fireHook (returns steer string)
  compaction.ts                 (moved; it is pure fs + jsonl, reusable by the CC SessionStart hook)
  truncate.ts                   truncateTail / formatSize / DEFAULT_MAX_* (vendored, see §3.3)
  process.ts                    createTempFileAllocator, killTree, ExecFn type, spawnExec (default
                                ExecFn built on child_process for non-Pi hosts)
  guards.ts                     AUTORESUME_TURN_LIMIT, CONSECUTIVE_FAILURE_OVERRIDE_LIMIT,
                                countConsecutiveDiscardOrCrashResults, autoResumeStopReasonFor
  activation.ts                 shouldAutoActivateAutoresearch (pure), AUTORESEARCH_ACTIVATION_ENTRY
  prompts.ts                    BENCHMARK_GUARDRAIL, composeResumeMessage, composeCompactionResumeMessage,
                                buildAutoresearchSystemPromptSection (body of before_agent_start)
  init.ts                       initExperiment(core input) -> {text, state}
  run.ts                        runExperiment(core input) -> {text, details}  (timeout, METRIC parse,
                                checks.sh, isAutoresearchShCommand)
  log.ts                        logExperiment(core input) -> {text, details, afterSteer, beforeSteer,
                                limitReached}  (validation, confidence, git commit/revert, jsonl append)
  dashboard-export.ts           template/logo loading, writeDashboardFile, static+SSE server
                                (node:http only; no ctx.ui) + openInBrowser
  index.ts                      barrel re-export
extensions/pi-autoresearch/
  index.ts                      thin Pi adapter: ExtensionAPI wiring, gating, widget, overlay,
                                shortcuts, auto-resume timer, compaction hook, /autoresearch command,
                                TypeBox schemas, renderCall/renderResult. Imports ../../src/core/*.ts
  commands.ts, shortcuts.ts     stay (Pi-only: AutocompleteItem, KeyId, getAgentDir)
  compaction.ts, hooks.ts,      become 1-line re-export shims of src/core (keeps tests' import paths)
  jsonl.ts, paths.ts
mcp/
  server.ts                     MCP stdio server (tools + resources), zod schemas
  session.ts                    per-process ExperimentState + lastRunChecks (the MCP "runtime")
.claude-plugin/plugin.json      name, version, description, author, skills, commands, mcpServers
.claude-plugin/marketplace.json optional single-entry marketplace for `claude plugin marketplace add`
.mcp.json                       { "mcpServers": { "autoresearch": { "command": "node", "args": [...] } } }
commands/autoresearch.md        /autoresearch slash command (Claude Code)
hooks/hooks.json                SessionStart (inject .auto/prompt.md) + Stop (auto-resume)
hooks/session-start.mjs, hooks/stop.mjs   plain Node scripts, import dist/core
dist/                           tsc output (gitignored, published): dist/core/**, dist/mcp/server.js
tests/core/*.test.mjs, tests/mcp/*.test.mjs   new tests; existing tests untouched
```

### 1.2 Dependency direction

`src/core` ← `extensions/pi-autoresearch` (Pi adapter)
`src/core` ← `mcp/server.ts` ← `.mcp.json` / `.claude-plugin`
`src/core` ← `hooks/*.mjs`
Nothing in `src/core` imports `@earendil-works/*`, `@sinclair/typebox`, `@modelcontextprotocol/*`, or `zod`.
Enforce with a test (`tests/core/no-host-imports.test.mjs`) that greps `src/core` for those specifiers.

### 1.3 Core API shape (the seam)

Pi's tool `execute` receives `ctx`, `signal`, `onUpdate`, and uses `pi.exec` and
`pi.sendUserMessage`. The core functions take exactly what they need and return data; the host
performs side effects (UI, steer messages, mode flips). Signatures:

```ts
// src/core/process.ts
export type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };
export type ExecFn = (cmd: string, args: string[],
  opts: { cwd: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;
export const spawnExec: ExecFn;             // child_process based; used by MCP server + hooks

// src/core/init.ts
export function initExperiment(params: InitParamsT, ctxCwd: string, state: ExperimentState):
  { ok: boolean; text: string; workDir: string; wasFirstInit: boolean };

// src/core/run.ts
export interface RunHost { exec: ExecFn; signal?: AbortSignal;
  onUpdate?: (u: { text: string; elapsed: string; truncation?: TruncationResult; fullOutputPath?: string }) => void;
  onStart?: () => void; onFinish?: () => void }       // adapter uses these for widget/overlay
export async function runExperiment(params: RunParamsT, ctxCwd: string, state: ExperimentState,
  host: RunHost): Promise<{ text: string; details: RunDetails & {truncation?, fullOutputPath?};
  lastRunChecks: {pass, output, duration} | null; lastRunDuration: number | null }>;

// src/core/log.ts
export interface LogRuntimeInput { lastRunChecks; lastRunDuration; autoresearchMode: boolean }
export async function logExperiment(params: LogParamsT, ctxCwd: string, state: ExperimentState,
  rt: LogRuntimeInput, exec: ExecFn): Promise<{ text: string; details: LogDetails;
  afterSteer: string | null; beforeSteer: string | null; limitReached: boolean }>;
```

`RunParamsT/InitParamsT/LogParamsT` are plain TS interfaces in `src/core/types.ts` (the TypeBox
schemas stay in the Pi adapter, the zod schemas live in `mcp/server.ts`; both must produce these
shapes — a test asserts the property-name sets match, see §5).

## 2. What moves to core vs what stays Pi-only (line ranges in current index.ts)

### 2.1 Moves to `src/core` verbatim (pure or node-only)

| Lines | Symbol(s) | Destination |
|---|---|---|
| 62-63 | `EXPERIMENT_MAX_LINES`, `EXPERIMENT_MAX_BYTES` | run.ts |
| 73-117 | `ASI`, `ExperimentResult`, `MetricDef`, `ExperimentState` | types.ts (export them) |
| 119-149 | `AUTORESUME_TURN_LIMIT`, `CONSECUTIVE_FAILURE_OVERRIDE_LIMIT`, `countConsecutiveDiscardOrCrashResults`, `autoResumeStopReasonFor` | guards.ts (index.ts re-exports; `tests/auto-resume-guards.test.mjs` imports from index.ts) |
| 151-178 | `RunDetails`, `LogDetails` | types.ts |
| 276-307 | `METRIC_LINE_PREFIX`, `DENIED_METRIC_NAMES`, `parseMetricLines` | metrics.ts |
| 309-336 | `commas`, `fmtNum`, `formatNum` | format.ts |
| 338-347 | `createTempFileAllocator` | process.ts (keep `pi-experiment-` temp prefix) |
| 350-357 | `formatElapsed` | format.ts |
| 359-372 | `killTree` | process.ts |
| 379-398 | `isAutoresearchShCommand` | run.ts (export; new direct tests) |
| 400-464 | `isBetter`, `sortedMedian`, `computeConfidence`, `currentResults` | state.ts / confidence.ts |
| 466-513 | `AutoresearchConfig`, `readConfig`, `readMaxExperiments`, `resolveWorkDir`, `canonicalPath`, `samePath` | config.ts |
| 515, 523-536 | `AUTORESEARCH_ACTIVATION_ENTRY`, `shouldAutoActivateAutoresearch` | activation.ts (index.ts re-exports; activation.test.mjs imports it from index.ts) |
| 567-598 | `validateWorkDir`, `findBaselineMetric`, `findBestMetric` | config.ts / state.ts |
| 604-609 | `autoresearchJsonlPath` … `autoresearchConfigPath` | paths.ts |
| 611-658 | `findBaselineRunNumber`, `findBaselineSecondary`, `cloneExperimentState` | state.ts |
| 713-726 | `createExperimentState` | state.ts |
| 1071-1072 | `BENCHMARK_GUARDRAIL` | prompts.ts |
| 1187-1204 | `composeResumeMessage`, `composeCompactionResumeMessage` (drop unused `_ctx` param) | prompts.ts |
| 1234-1273 | `hasLoggedExperiment`, `readJsonlLines`, `readLastRun`, `buildSessionSnapshot`, `fireHook` | jsonl.ts / hooks.ts. `fireHook` returns the steer string; **the adapter** does `pi.sendUserMessage(steer, {deliverAs:"steer"})` |
| 1300-1328 (inside `reconstructState`) | the jsonl → state block | state.ts `loadStateFromJsonl(workDir): {state, hasPersistedLog, loadedFromJsonl}` |
| 1516-1555 | body of `before_agent_start` (string building only) | prompts.ts `buildAutoresearchSystemPromptSection(workDir): string` |
| 1573-1660 | `init_experiment.execute` minus `recordAutoresearchActivation`/`setAutoresearchMode`/`updateWidget`/`sendUserMessage` | init.ts |
| 1693-2064 | `run_experiment.execute` minus `runtime.runningExperiment`/`updateWidget`/`overlayTui` (become `host.onStart/onFinish`), `onUpdate` (adapter forwards), `pi.exec` → `host.exec` | run.ts |
| 2212-2491 | `log_experiment.execute` minus `recordAutoresearchActivation`/`setAutoresearchMode`/`ctx.abort`/`updateWidget`/`overlayTui`/`sendUserMessage`; `pi.exec` → `exec` | log.ts |
| 2762-2958 | `TITLE_PLACEHOLDER`, `packageRoot`, `templatePath`, `readTemplate`, `logoDataUrl`, `readJsonlContent`, `escapeHtml`, `injectDataIntoTemplate`, `openInBrowser`, `stopDashboardServer`, `writeDashboardFile`, `CONTENT_TYPES`, `fileContentType`, `resolveServedFile`, `registerSseClient`, `broadcastDashboardUpdate`, `startStaticServer` | dashboard-export.ts, wrapped in `createDashboardExporter()` returning `{ start(workDir): Promise<{url}>, stop(), broadcast(workDir) }` so module state is per-instance, not per-process |

`packageRoot()` currently resolves `../..` from the extension dir. In core it must resolve
`assets/` relative to **the core file's own location** and work both from `src/core` (depth 2)
and `dist/core` (depth 2) — same depth, so `path.resolve(dirname(fileURLToPath(import.meta.url)), "../..")` still works. Add a test.

Already-pure helper modules `paths.ts`, `jsonl.ts`, `hooks.ts`, `compaction.ts` move to
`src/core/` with their bodies unchanged; the files under `extensions/pi-autoresearch/` become
`export * from "../../src/core/<name>.ts";` so `tests/{paths,jsonl-helpers,compaction}.test.mjs`
keep importing the old paths unchanged.

### 2.2 Stays in the Pi adapter (`extensions/pi-autoresearch/index.ts`)

| Lines | What | Why Pi-only |
|---|---|---|
| 17-27 | Pi/TUI/TypeBox imports | host types |
| 180-192 | `AutoresearchRuntime` (timers, runningExperiment) + 728-759 `createSessionRuntime`, `createRuntimeStore` | Pi session keying |
| 198-269 | `RunParams`, `InitParams`, `LogParams` (TypeBox + `StringEnum` from pi-ai); `LogParams` stays exported (log-params-schema.test.mjs) | Pi tool schema format |
| 538-565 | `autoresearchActivationData`, `recordedActivationDecision` | reads `ctx.sessionManager` |
| 660-711 | `clamp`, `truncateDisplayText`, `joinPartsToWidth`, `appendRightAlignedAdaptiveHint`, `getTuiSize` | pi-tui |
| 769-1064 | `renderDashboardLines` | `Theme` |
| 1076-1185 | gating (`registerGatedTool`, `setAutoresearchMode`), activation entries, auto-resume timer machinery (`schedulePendingResume` etc.) | ExtensionAPI |
| 1206-1229 | `autoresearchCompactionFor`, `sendWhenReady` | Pi events |
| 1276-1298 | overlay spinner, `clearOverlay`, `clearSessionUi` | TUI |
| 1329-1388 | session-history fallback in `reconstructState` + mode activation; 1390-1458 `updateWidget` | Pi session/UI |
| 1460-1514 | all `pi.on(...)` handlers | Pi events |
| 1559-1572, 1662-1676, 1678-1692, 2066-2192, 2194-2211, 2493-2576 | tool registration metadata (`label`, `promptSnippet`, `promptGuidelines`), `renderCall`, `renderResult` | Pi tool UI (the description/guideline strings may be shared via a `src/core/tool-text.ts` constant so MCP descriptions match — optional, step 9) |
| 2578-2733 | fullscreen overlay | TUI |
| 2735-2760 | shortcuts | Pi keybindings |
| 2960-2985 | `exportDashboard(ctx)` wrapper (notify) | ctx.ui |
| 2987-3142 | `/autoresearch` command, `stopAutoresearchLoop`, `turnAutoresearchOff`, `finalizeAutoresearch`, `turnOffAndSettle` | Pi command API |

Expected size after refactor: index.ts ≈ 1500-1700 lines; core ≈ 1400 lines split across files.

## 3. Constraints and build/runtime decisions

### 3.1 Pi entry stays `extensions/`
Pi loads `./extensions` from the `pi` manifest and resolves relative `.ts` imports with its own
loader (jiti/tsx-like). `extensions/pi-autoresearch/index.ts` will import
`../../src/core/*.ts` with explicit `.ts` extensions — same style as today's `./hooks.ts`.
Verify that the `files` array in package.json ships `src/` (it must; Pi installs from the npm
tarball). Keep `.ts` sources published.

### 3.2 MCP server runtime: **compile with `tsc` to `dist/`** (recommended)
Options considered:
- (A) `node --experimental-strip-types mcp/server.ts`: works on Node 22.6+, but (1) `.mcp.json`
  would need the flag in `args` and prints an ExperimentalWarning to stderr on every start,
  (2) strip-types forbids TS-only syntax that is not erasable (enums, namespaces, parameter
  properties) — fine today, but a footgun, (3) `import ... from "./x.ts"` extension-ful
  imports are required (we already do that), (4) Node ≥23.6 strips by default, Node 22 needs the
  flag → version-sensitive `.mcp.json`.
- (B) **`tsc` → `dist/`** with `"module": "nodenext"`, `"allowImportingTsExtensions": false`,
  `"rewriteRelativeImportExtensions": true` (TS ≥5.7) so `./x.ts` imports become `./x.js` in
  output. `.mcp.json` runs `node dist/mcp/server.js` with no flags, works on any Node ≥18, no
  warnings on stderr (important: MCP stdio clients treat stderr as logs but noisy startup is ugly).
  `dist/` is gitignored and built in `prepublishOnly`/`prepare`. The plugin as installed from the
  marketplace must contain `dist/` → **commit-free but tarball-included**, and the marketplace
  entry points at the npm package or a release that includes `dist/`. (Open question Q1.)
- Tests keep using `--experimental-strip-types` against `src/` (unchanged, fast, no build step).

Decision: (B). `type`-only imports: use `import type { … }` everywhere in core so both the
strip-types path (tests) and tsc path work; `verbatimModuleSyntax: true` in tsconfig enforces it.

### 3.3 Severing the four Pi runtime imports used by core logic
- `truncateTail`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize` (pi-coding-agent):
  vendor into `src/core/truncate.ts` (copy from pi-mono `core/tools/truncate.ts`, MIT; add a
  THIRD_PARTY_NOTICES entry). Add `tests/core/truncate.test.mjs` that runs both the vendored
  and the pi implementation (pi is a devDependency) on the same fixtures and asserts equality —
  this is the guard that "move, don't rewrite" held.
- `StringEnum` (pi-ai): used only in TypeBox `LogParams` → stays in adapter.
- `Text`, `truncateToWidth`, `matchesKey`, `visibleWidth` (pi-tui): UI only → adapter.
- `pi.exec`: replaced by `ExecFn`; adapter passes `(cmd, args, opts) => pi.exec(cmd, args, opts)`.

### 3.4 package.json changes
```jsonc
{
  "name": "pi-autoresearch", "version": "2.0.0",
  "exports": { ".": "./dist/core/index.js", "./core": "./dist/core/index.js", "./mcp": "./dist/mcp/server.js" },
  "bin": { "autoresearch-mcp": "./dist/mcp/server.js" },      // shebang line in mcp/server.ts
  "files": ["extensions", "src", "dist", "skills", "assets", "commands", "hooks", ".claude-plugin", ".mcp.json", "README.md", "CHANGELOG.md", "LICENSE", "package.json"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --experimental-strip-types --test tests/*.test.mjs tests/core/*.test.mjs",
    "test:mcp": "npm run build && node --test tests/mcp/*.test.mjs",
    "mcp": "node dist/mcp/server.js",
    "prepublishOnly": "npm run build && npm test && npm run test:mcp"
  },
  "pi": { "extensions": ["./extensions"], "skills": ["./skills"] },   // unchanged
  "dependencies": { "@modelcontextprotocol/sdk": "^1.x", "zod": "^3.23" },
  "devDependencies": { ...existing, "typescript": "^5.7" }
}
```
Keep `peerDependencies` for the Pi packages (Pi host supplies them; the MCP path never imports them).
`.gitignore` += `dist/`. CI: add `pnpm build` and `pnpm test:mcp` steps.

## 4. Claude Code side

### 4.1 `.claude-plugin/plugin.json`
```json
{ "name": "autoresearch", "version": "2.0.0",
  "description": "Autonomous experiment loop: run, measure, keep or discard.",
  "author": { "name": "David Cortés" }, "license": "MIT",
  "skills": "./skills", "commands": "./commands", "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json" }
```
`.mcp.json`:
```json
{ "mcpServers": { "autoresearch": { "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"] } } }
```
(`${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code for plugin-scoped `.mcp.json`; for a
project-local `.mcp.json` use a relative path instead — document both in README.)

### 4.2 MCP server (`mcp/server.ts`)
- `McpServer` + `StdioServerTransport`. Process cwd = project dir (Claude Code launches servers
  in the project root); treat `process.cwd()` as `ctxCwd`, then `resolveWorkDir()` as today.
- State: on start, `loadStateFromJsonl(resolveWorkDir(cwd))`; one `ExperimentState` + `lastRunChecks`
  per process (mcp/session.ts). The on-disk log is the source of truth, same as Pi.
- Tools (names/params identical to Pi; zod schemas mirror TypeBox):
  - `init_experiment` → `initExperiment`
  - `run_experiment` → `runExperiment` with `spawnExec`; stream progress via
    `server.sendLoggingMessage`/progress notifications if a `progressToken` is present (optional).
  - `log_experiment` → `logExperiment`; append any `afterSteer`/`beforeSteer` text to the
    tool result text (Claude Code has no "steer" channel; this is the documented mapping).
  - `get_status` (new, MCP-only) → compact JSON: name, metric, direction, baseline, best,
    run counts, confidence, maxExperiments, last 10 runs. Pi has the widget for this.
- Resources: `autoresearch://log` (text/plain, raw `log.jsonl`), `autoresearch://prompt`
  (`prompt.md`), `autoresearch://ideas`, `autoresearch://status` (JSON, same as get_status).
  Return `isError`-free empty content when the file does not exist.
- Gating: Pi hides tools until `/autoresearch`. MCP cannot toggle tool visibility per turn
  reliably; instead `run_experiment`/`log_experiment` return an error text
  "Autoresearch session not initialized — call init_experiment or run /autoresearch" when no
  config header exists in log.jsonl. Document as a deliberate difference.
- Never write to stdout except via the transport; all diagnostics to stderr.

### 4.3 `commands/autoresearch.md`
```markdown
---
description: Start or resume an autoresearch loop (optimize a metric autonomously)
argument-hint: <goal> | off | finalize | clear | status
---
If "$ARGUMENTS" is empty or "help": print the subcommand list and stop.
If "$ARGUMENTS" is "status": call the autoresearch `get_status` tool and summarize. Stop.
If "$ARGUMENTS" is "clear": delete `.auto/log.jsonl` (ask for confirmation first) and stop.
If "$ARGUMENTS" is "off": write `off` to `.auto/.claude-state` (consumed by the Stop hook) and stop.
If "$ARGUMENTS" is "finalize": write `off` as above, then follow the `autoresearch-finalize` skill.
Otherwise (a goal): write `on` to `.auto/.claude-state`.
  - If `.auto/prompt.md` exists: read it and `.auto/log.jsonl`, then continue the loop with
    "$ARGUMENTS" as extra context.
  - Else: follow the `autoresearch-create` skill with goal "$ARGUMENTS".
Use the MCP tools init_experiment / run_experiment / log_experiment. Be careful not to overfit
to the benchmarks and do not cheat on the benchmarks. NEVER STOP until interrupted.
```
(`.auto/.claude-state` is a tiny new file `{"active":true|false,"autoResumeTurns":n}`; it is the
Claude Code analogue of Pi's `pi-autoresearch.activation` session entry. Add it to the revert
exclusion automatically — it lives under `.auto/`, which is already excluded.)

### 4.4 Hooks mapping (`hooks/hooks.json`)
| Pi behaviour | Claude Code mapping |
|---|---|
| `before_agent_start` system-prompt section + pointer to `.auto/prompt.md` (index.ts 1516-1555) | `SessionStart` hook (matcher `startup|resume|compact`) → `hooks/session-start.mjs`: if `.auto/.claude-state` is active, print `buildAutoresearchSystemPromptSection(workDir)` on stdout (Claude Code adds it as context). After `compact` it also prints `buildAutoresearchCompactionSummary(...)`. |
| `agent_end` → auto-resume timer (`pi.sendUserMessage("Run the next iteration now…")`) | `Stop` hook → `hooks/stop.mjs`: reads `.claude-state`; if active and `stop_hook_active` is false and `autoResumeStopReasonFor({autoResumeTurns, state})` is null, increments `autoResumeTurns`, writes state, exits with `{"decision":"block","reason": composeResumeMessage()}`. Otherwise exits 0 (lets the agent stop) and prints the stop reason. Turn-limit guard reuses `AUTORESUME_TURN_LIMIT` (200) and the consecutive-failure override (20) from core. |
| "experiment gate" (only resume if an experiment ran this turn) | stop.mjs compares `log.jsonl` run count to the count stored in `.claude-state` at the last Stop; no new runs → no block (prevents the chat-only infinite loop). |
| `session_before_compact` deterministic summary | covered by SessionStart `compact` matcher above (best-effort; Claude Code compaction cannot be replaced, only supplemented). |
| Tool gating by mode | not mappable → error text in tools (§4.2). |
| Live widget, fullscreen overlay, keyboard shortcuts, `ctx.ui.notify` | **not applicable** (no TUI surface). `get_status` tool + `/autoresearch status` replace the widget; `/autoresearch export` could be a `get_status`-adjacent tool `open_dashboard` reusing `dashboard-export.ts` (optional, step 10). |
| `ctx.abort()` on max iterations | `logExperiment` returns `limitReached`; MCP tool appends "STOP the loop now"; stop.mjs sees `maxExperiments` reached and does not block. |

## 5. Test plan

Existing: all `tests/*.test.mjs` (87 tests) + `tests/finalize_test.sh` unchanged, still importing
from `extensions/pi-autoresearch/*.ts`. They are the regression oracle for "no behaviour change".

New `tests/core/` (run with strip-types, no build):
- `metrics.test.mjs`: `parseMetricLines` (µ names, dup last-wins, denied names, non-finite, no-match).
- `confidence.test.mjs`: `<3` points → null, MAD=0 → null, no kept → null, known numeric case; `isBetter`, `findBestMetric`, `findBaselineSecondary` fallback.
- `format.test.mjs`: `formatNum` integers/fractions/negatives/units, `formatElapsed`.
- `run-guard.test.mjs`: `isAutoresearchShCommand` table (env prefixes, wrappers, chaining rejected, legacy `autoresearch.sh`).
- `run.test.mjs`: `runExperiment` in a tmp dir with `spawnExec`: exit 0 with METRIC lines → parsedPrimary; non-zero exit → crashed; timeout 1s on `sleep 5` → timedOut; checks.sh pass/fail/timeout; measure.sh-exists guard; maxExperiments block; output truncation + temp file.
- `log.test.mjs`: tmp git repo; keep → commit created and `experiment.commit` = new sha, jsonl line appended, `Result:` trailer; discard → working tree reverted but `.auto/` preserved; checks-failed gate; secondary metric missing/new/force; confidence present after 3 runs; hooks `after`/`before` steer returned; limitReached.
- `init.test.mjs`: first init creates jsonl with config header; re-init appends and bumps segment; workingDir validation.
- `state.test.mjs`: `loadStateFromJsonl` round-trip vs `reconstructJsonlState`; `cloneExperimentState` deep copy.
- `truncate.test.mjs`: vendored vs pi `truncateTail`/`formatSize` equality on fixtures.
- `prompts.test.mjs`: system prompt section with/without checks and ideas; message texts match the v1.9.0 strings byte-for-byte (copy expected strings into the test).
- `no-host-imports.test.mjs`: no `@earendil-works|typebox|modelcontextprotocol|zod` under `src/core`.
- `schema-parity.test.mjs`: property names of TypeBox `LogParams/RunParams/InitParams` == zod shapes' keys (import both; zod one from `mcp/server.ts` via an exported `schemas` object).

New `tests/mcp/` (needs `dist/`; `test:mcp` script builds first):
- `smoke.test.mjs`: `Client` + `StdioClientTransport` spawning `node dist/mcp/server.js` with
  `cwd` = tmp git repo; `listTools` has the 4 tools; `listResources` has the 4 URIs; call
  `init_experiment` → `run_experiment({command:"bash .auto/measure.sh"})` (measure.sh echoes
  `METRIC t_ms=5`) → `log_experiment(keep)` → `readResource("autoresearch://log")` contains 2
  lines; `get_status` shows 1 run; server exits cleanly on transport close.
- `uninitialized.test.mjs`: `run_experiment` before init returns the "not initialized" text.

Adapter-level: `tests/activation.test.mjs` already exercises the Pi tools end-to-end through the
harness (`pi.exec` mocked) — after the refactor it must pass without edits; that proves the
adapter still forwards `exec`, steer messages and mode flips exactly as before.

CI: `pnpm test` (existing + core), `pnpm build`, `pnpm test:mcp`, keep site steps.

## 6. Ordered implementation steps (Builder)

Rules: run `pnpm test` after every step; it must stay at 87 (then 87+N) passing. Commit per step.
Do not change behaviour of the Pi extension. Move code, don't rewrite. No reformatting of moved
bodies (keep diffs reviewable with `git diff --color-moved`).

1. **Scaffold**: `src/core/`, `tsconfig.json` (noEmit, for editors) and `tsconfig.build.json`
   (`outDir: dist`, `rootDir: .`, include `src/core`, `mcp`; nodenext; verbatimModuleSyntax;
   rewriteRelativeImportExtensions). Add `typescript` devDep, `build` script, `dist/` to
   `.gitignore`. Verify `pnpm build` on empty core compiles. Tests: 87.
2. **Move pure helper modules**: `git mv` `paths.ts jsonl.ts hooks.ts compaction.ts` to
   `src/core/`; leave re-export shims at old paths; fix relative imports inside them. Tests: 87.
3. **Extract leaf helpers** from index.ts into `types.ts, metrics.ts, format.ts, confidence.ts,
   state.ts, config.ts, process.ts, guards.ts, activation.ts, prompts.ts` (table §2.1, rows
   62-726 + 1071-1204). index.ts imports them; re-exports `AUTORESUME_TURN_LIMIT`,
   `CONSECUTIVE_FAILURE_OVERRIDE_LIMIT`, `autoResumeStopReasonFor`,
   `countConsecutiveDiscardOrCrashResults`, `shouldAutoActivateAutoresearch`. Tests: 87.
   Add `tests/core/{metrics,confidence,format,run-guard,prompts,no-host-imports}.test.mjs`.
4. **Vendor truncation**: `src/core/truncate.ts`; switch index.ts imports of `truncateTail`,
   `DEFAULT_MAX_*`, `formatSize` to it; add `truncate.test.mjs` parity test; update
   THIRD_PARTY_NOTICES. Tests: 87+.
5. **Extract jsonl/hook glue** (1234-1273) into core; adapter wraps `fireHook` with
   `pi.sendUserMessage`. Extract `loadStateFromJsonl` from `reconstructState`. Add `state.test.mjs`.
6. **Extract `initExperiment`** (init.ts); adapter's `execute` becomes: validate → call core →
   `recordAutoresearchActivation`/`setAutoresearchMode`/`updateWidget`/steer → return. Keep the
   returned `content`/`details` objects identical. Add `init.test.mjs`.
7. **Extract `runExperiment`** (run.ts) with `RunHost`; adapter supplies `exec: pi.exec`,
   `onUpdate` passthrough, `onStart/onFinish` for widget/overlay. `details` must be the same
   object shape (activation tests read it). Add `run.test.mjs`.
8. **Extract `logExperiment`** (log.ts); adapter handles `limitReached` (record activation off,
   mode off, `ctx.abort()`), steers, widget. Add `log.test.mjs`.
9. **Extract dashboard export** (dashboard-export.ts, `createDashboardExporter`); adapter keeps
   `exportDashboard(ctx)` notify wrapper and calls `exporter.broadcast(workDir)` where
   `broadcastDashboardUpdate` was called (init/log). Optional: shared tool description strings.
10. **MCP server**: `mcp/session.ts`, `mcp/server.ts` (tools, resources, zod schemas, shebang),
    deps `@modelcontextprotocol/sdk` + `zod`, `bin`, `exports`, `files`, `mcp`/`test:mcp` scripts.
    Add `tests/mcp/*.test.mjs` and `schema-parity.test.mjs`. CI steps.
11. **Claude Code plugin files**: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
    `.mcp.json`, `commands/autoresearch.md`, `hooks/hooks.json`, `hooks/session-start.mjs`,
    `hooks/stop.mjs` (import from `../dist/core/index.js`; guard with a clear error if `dist/`
    is missing: "run `npm run build`"). Add `tests/core/hooks-scripts.test.mjs` that runs
    stop.mjs with synthetic stdin JSON and asserts block/allow decisions and the turn-limit guard.
12. **Docs**: README section "Use with Claude Code" (install via marketplace / `claude mcp add`),
    CHANGELOG `[2.0.0]` entry, `skills/autoresearch-create/SKILL.md` line "Dashboard: ctrl+shift+t"
    is already stale for Pi (no default chords since 1.7.0) — fix to "Dashboard: /autoresearch
    dashboard (pi) or get_status (Claude Code)". Final: `pnpm test && pnpm build && pnpm test:mcp`.

Each step's acceptance: existing 87 tests pass unchanged, `git diff --stat extensions/` shows
only deletions/imports in index.ts for steps 3-9, and `node --experimental-strip-types -e
"import('./extensions/pi-autoresearch/index.ts')"` loads.

## 7. Risks and open questions

R1. **CI forbids tracked files under `docs/`**: `.github/workflows/ci.yml` runs
`test -z "$(git ls-files site/build docs)"` (added with the website, commit e63bad1). Committing
this spec at `docs/SPEC-multi-host.md` fails CI. Resolution needed: either move the spec (e.g.
`SPEC-multi-host.md` at repo root or `site/content/`), or change the CI guard to `site/build`
only. Recommend relaxing the guard (the `docs` part was a leftover from a GitHub-Pages-from-docs
setup); Builder step 1 should do that. **Flag to the user.**
R2. `dist/` must exist for the plugin to run. Marketplace installs from a git ref, not npm, so
`dist/` would need to be committed on a release branch/tag, or the marketplace entry uses the npm
tarball. Q1: which distribution channel does the user want for the Claude Code plugin
(git marketplace vs `npx pi-autoresearch` via `bin`)? If git, consider committing `dist/` only on
tags via the publish workflow, or using option (A) strip-types to avoid a build (requires Node
≥22.6 and the ExperimentalWarning noise).
R3. Steer messages have no Claude Code equivalent; hook stdout is folded into tool results. Hook
authors relying on "steer arrives as a separate user message" see a different UX. Document.
R4. Stop-hook auto-resume differs from Pi's 800 ms settle timer: Claude Code's `Stop` fires
exactly once per turn, so "block with reason" is the only continuation mechanism; a user who
wants to interrupt must `/autoresearch off` (writes state) or Escape. The `stop_hook_active`
flag plus the run-count gate plus the 200-turn cap prevent runaway loops. Verify that the
`block` decision text is delivered as a user turn (it is, per Claude Code hooks docs) — confirm
in a manual session.
R5. `process.cwd()` for the MCP server: if Claude Code launches the server from a different cwd
than the project (e.g. user-scoped `.mcp.json`), `.auto/` is not found. Mitigation: accept
`AUTORESEARCH_CWD` env override and document it; plugin-scoped `.mcp.json` inherits the project cwd.
R6. Schema drift between TypeBox (Pi) and zod (MCP): mitigated by `schema-parity.test.mjs`;
descriptions are shared via constants in step 9 (optional).
R7. Vendored `truncateTail` may diverge from pi's future versions; parity test pins current
behaviour, which is what the Pi adapter must preserve anyway.
R8. `renderDashboardLines` and widget stay in the adapter → no dashboard in Claude Code except
the browser export (`dashboard-export.ts` is in core, so an `open_dashboard` tool is cheap: Q2
whether to add it in 2.0 or later).
R9. Concurrency: one MCP process per Claude Code session; two sessions on one repo would both
append to `log.jsonl` — same as two pi sessions today. No change, document.
Q3. Package name for the plugin (`autoresearch` vs `pi-autoresearch`) and whether the npm
package should be renamed; spec assumes npm name unchanged and plugin name `autoresearch`.
Q4. Should `get_status` also be added to Pi for parity (gated like the others)? Cheap, but it is
a behaviour addition; default: no in 2.0.

## 8. Adversarial review amendments (AUTHORITATIVE — override §3, §4, §6 where they conflict)

Verified against the code and toolchain on 2026-11-06: every line range in §2 matches
`index.ts` at v1.9.0; Pi discovers only `extensions/pi-autoresearch/index.ts` (jiti loader,
subdirectory-index rule, no recursion), so re-export shims beside it are never loaded as
extensions and `../../src/core/*.ts` imports resolve through jiti; Node in CI/dev is 22.23.4,
which strips types **by default** (since 22.18); `@modelcontextprotocol/sdk` latest is 1.32.2
with peer `zod ^3.25 || ^4.0`; the git revert in `log_experiment` (index.ts 2437-2438) already
excludes `**/.auto/**`, so `.auto/.claude-state` survives discards.

### A1. Build decision REVERSED: no build step is required to run the plugin (fixes R2/Q1)
§3.2 chose `tsc → dist/`, which makes a git-marketplace install non-functional (no `dist/`).
Instead, every non-Pi entry point runs the TypeScript sources directly:

```
node --experimental-strip-types --no-warnings=ExperimentalWarning <entry>.ts
```
- On Node 22.6-22.17 the flag enables stripping; on ≥22.18 it is a harmless no-op and the
  warning suppressor keeps stderr clean. Minimum supported Node for the Claude Code side:
  **22.6** (document). `engines.node` stays `>=22`.
- MCP server lives at **`src/mcp/server.ts`** (not `mcp/`). `.mcp.json`:
  ```json
  { "mcpServers": { "autoresearch": { "command": "node",
      "args": ["--experimental-strip-types", "--no-warnings=ExperimentalWarning",
               "${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts"] } } }
  ```
- Hook scripts are **`hooks/session-start.ts`** and **`hooks/stop.ts`** importing
  `../src/core/index.ts`, invoked from `hooks/hooks.json` with the same two flags.
- `tsc` is kept only as an optional typecheck + npm `exports` build: `tsconfig.json` with
  `"rootDir": "src"`, `"outDir": "dist"`, `"module": "nodenext"`, `"moduleResolution": "nodenext"`,
  `"target": "es2022"`, `"strict": true`, `"verbatimModuleSyntax": true`,
  `"erasableSyntaxOnly": true` (guarantees strip-types compatibility),
  `"rewriteRelativeImportExtensions": true`, `"skipLibCheck": true`, include `src/**/*.ts`.
  (§3.2's `rootDir: "."` was a bug: it would emit `dist/src/core/...`, not `dist/core/...`.)
  Scripts: `"typecheck": "tsc --noEmit"`, `"build": "tsc"`; CI runs `typecheck`, not `build`.
  `dist/` is gitignored and only produced by `prepublishOnly` for npm consumers.
- Pin devDependency `typescript` to `^5.9` (npm `latest` is 7.x; do not use it).
- `tests/mcp/*.test.mjs` spawn `node --experimental-strip-types --no-warnings=ExperimentalWarning
  src/mcp/server.ts` via `StdioClientTransport`; `test:mcp` needs no build. Fold them into the
  main `test` script: `node --experimental-strip-types --test tests/*.test.mjs tests/core/*.test.mjs tests/mcp/*.test.mjs`.
- `bin`: `{ "autoresearch-mcp": "./bin/autoresearch-mcp.mjs" }` — a 6-line launcher that
  spawns `process.execPath` with the two flags and `src/mcp/server.ts`, `stdio: "inherit"`.
  Keep `exports` minimal: `{ ".": "./src/core/index.ts" }` is not valid for plain-JS consumers,
  so omit `exports` entirely in 2.0 (Pi uses the `pi` manifest; Claude Code uses `.mcp.json`).

### A2. CI `docs/` guard (fixes R1) — DECIDED
Change `.github/workflows/ci.yml` last step to `test -z "$(git ls-files site/build)"`. The
`docs` entry was a leftover; this spec lives at `docs/SPEC-multi-host.md`. Builder step 1.

### A3. Claude Code plugin file formats (corrects §4.1/§4.4)
- `.claude-plugin/plugin.json`: keep to `name`, `version`, `description`, `author`, `license`,
  `keywords`. Do **not** set `skills`/`commands`/`hooks`/`mcpServers` paths — `skills/`,
  `commands/`, `hooks/hooks.json` and `.mcp.json` at the plugin root are auto-discovered, and
  explicit paths only add a way to get them wrong.
- `hooks/hooks.json` must use the wrapper form:
  ```json
  { "hooks": {
      "SessionStart": [ { "matcher": "startup|resume|compact",
        "hooks": [ { "type": "command", "command": "node --experimental-strip-types --no-warnings=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.ts\"" } ] } ],
      "Stop": [ { "hooks": [ { "type": "command", "timeout": 30,
        "command": "node --experimental-strip-types --no-warnings=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/hooks/stop.ts\"" } ] } ]
  } }
  ```
- Hook stdin JSON carries `cwd`, `session_id`, `hook_event_name`, and for SessionStart
  `source` (`startup|resume|clear|compact`), for Stop `stop_hook_active`. Use `cwd` from stdin,
  never `process.cwd()`, to locate `.auto/`.
- SessionStart hook: print context on stdout (exit 0). Stop hook: print
  `{"decision":"block","reason":"<resume message>"}` on stdout and exit 0 to continue; print
  nothing and exit 0 to allow the stop. Never exit 2 (that would surface as an error).
- Tool names inside Claude Code are prefixed (`mcp__plugin_autoresearch_autoresearch__run_experiment`
  style). `commands/autoresearch.md` and skills refer to tools by their bare names
  (`init_experiment`, …) — Claude resolves them; do not hardcode the prefix anywhere.
- `commands/autoresearch.md` frontmatter: `description`, `argument-hint`, and
  `allowed-tools: Read, Write, Bash(git *), Bash(cat *)` is optional; omit to avoid over-restriction.
- Stop-hook run-count gate: `.auto/.claude-state` = `{"active":bool,"autoResumeTurns":n,"runsAtLastStop":n}`.
  The hook reads run count from `log.jsonl` via `reconstructJsonlState`; it blocks only if
  `active && !stop_hook_active && runs > runsAtLastStop && autoResumeStopReasonFor(...) === null`.
  Every decision path rewrites `runsAtLastStop` to the current count.

### A4. Core seam clarifications for the Builder
- `src/core/index.ts` barrel exports everything the adapter, MCP server and hooks need. The
  adapter may import from the barrel or from individual files; MCP/hooks import the barrel only.
- `ExecFn` must be a strict superset of what `pi.exec` returns for the fields core reads
  (`code`, `stdout`, `stderr`, `killed`); check `node_modules/@earendil-works/pi-coding-agent`'s
  `ExtensionAPI.exec` type and copy its option names (`cwd`, `timeout`, `signal`) so the
  adapter can pass `pi.exec` through without an adapter function.
- `spawnExec` (child_process) must honour `timeout` by killing the **process tree**
  (reuse `killTree`) and set `killed: true`, so `runExperiment`'s timeout path behaves the same
  under MCP as under Pi.
- Vendored `src/core/truncate.ts`: copy from `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js`
  (205 lines, MIT) and type it; keep the parity test from §5.
- `packageRoot()` in `dashboard-export.ts`: `path.resolve(dirname(fileURLToPath(import.meta.url)), "../..")`
  → repo root from `src/core/`; `assets/template.html` and `assets/logo.webp` are already in
  `files`.
- `zod` version: `^3.25` (works with SDK 1.32 and is zod-4-compatible API-wise for `z.object`).

### A5. Amended Builder steps (replace §6 steps 1, 10, 11)
1. Scaffold: `src/core/`, `src/mcp/`, `hooks/`, `bin/`; `tsconfig.json` per A1; add
   `typescript@^5.9` devDep and `typecheck`/`build` scripts; `dist/` to `.gitignore`; relax the
   CI guard (A2); add `pnpm typecheck` to CI after `pnpm test`. Tests: 87.
10. MCP server at `src/mcp/server.ts` (+ `src/mcp/session.ts`), deps `@modelcontextprotocol/sdk@^1.32`
    + `zod@^3.25`, `bin/autoresearch-mcp.mjs`, `files` += `src`, `bin`, `hooks`, `commands`,
    `.claude-plugin`, `.mcp.json`. Tests in `tests/mcp/` spawn the `.ts` entry directly (A1).
11. Plugin files per A3; hook scripts are `.ts`; `tests/core/hooks-scripts.test.mjs` runs
    `hooks/stop.ts` with synthetic stdin for: inactive → allow; active+new runs → block with the
    exact `composeResumeMessage()` text; `stop_hook_active` → allow; no new runs → allow;
    turn limit 200 → allow and state unchanged; 21 consecutive discards → allow.

### A6. Decisions on open questions
Q1: git marketplace + npm both work with A1 (no build). Q2: `open_dashboard` MCP tool — NOT in
2.0. Q3: plugin name `autoresearch`, npm name unchanged. Q4: no `get_status` in Pi for 2.0.
