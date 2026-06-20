# PromptMate for VS Code — Architecture & Port Design

A VS Code extension that replicates the PromptMate Chrome extension: it turns
vague prompts into clear, well-specified ones, in place, with a streaming
rewrite. This document records the analysis of the Chrome source and the design
decisions behind the VS Code port living in this folder.

---

## 1. Chrome extension — architecture analysis

Manifest V3 extension (`../chrome`), built with Vite + `vite-plugin-web-extension`.

```
chrome/
  manifest.json                 MV3 manifest: permissions, content scripts, action, commands
  src/
    background/                 the service worker — privileged network + orchestration
      service-worker.ts         entry: command + message + port listeners
      orchestrator.ts           builds prompts, gates (NO_KEY / RATE_LIMIT), streams via a provider
      rate-limit.ts             10 req / 60 s sliding window (in-memory)
      triage/prompt.ts          system/user prompt construction (enhance + generate)
      providers/
        provider.ts             Provider interface: stream(system,user,onDelta,signal)
        anthropic.ts            SSE streaming against api.anthropic.com
        openai.ts               SSE streaming against api.openai.com
    content/                    injected into chatgpt.com / claude.ai / gemini
      content-script.ts         picks a SiteAdapter by URL, calls bootstrap()
      injector.ts               the floating "wand": positioning, drag, click → onTrigger → stream
      adapters/                 per-site DOM glue (find input, read/write prompt text)
        adapter.ts, chatgpt.ts, claude.ts, gemini.ts, generic.ts
      panel/                    mode menu + undo/error toasts (panel.ts) and styling (panel.css)
    options/                    action popup + options page (settings + "Craft a prompt")
      options.html, options.ts
    shared/                     cross-context contracts
      types.ts                  EnhanceMode, PromptType, Settings, ErrorCode, …
      messages.ts               ContentToWorker / WorkerToContent port protocol
      storage.ts                chrome.storage.local load/save of Settings
```

**Core flow.** The content script injects a draggable wand next to the prompt
box on a supported site. Clicking it (or the `Ctrl+Shift+E` command) reads the
draft from the page's textarea/contenteditable, opens a long-lived
`chrome.runtime` **port** to the service worker, and the worker streams an LLM
rewrite back delta-by-delta. The content script writes each delta into the input
in place, then shows an **Undo** toast. The worker holds the API key and does the
network call (the content script can't, due to page CSP/CORS). Settings + key
live in `chrome.storage.local`; the options page also offers a one-shot "Craft a
prompt" generator using the same streaming pipeline.

**Why each piece exists in the browser:** the privileged background context is
the only place that can hold a key and bypass page CORS; the content script +
site adapters exist *only* because the extension has to reach into a web page it
doesn't own; the wand overlay and toasts are hand-built because there's no host
UI to hook into.

---

## 2. VS Code extension — specification

The editor is sandboxed: an extension **cannot** inject UI into another
extension's chat webview (Copilot, Claude in VS Code). So the "wand on someone
else's text box" model doesn't port literally. Instead we map each capability to
its native VS Code surface:

| Chrome capability | VS Code surface |
|---|---|
| Wand on a web prompt box | **Command** `promptmate.enhance` + keybinding + status-bar button, operating on the **active editor selection** (or whole doc) |
| Caret → mode menu | **QuickPick** (`promptmate.enhanceWithMode`) |
| Streaming rewrite into the input | Streaming **`WorkspaceEdit`** into the editor (`EditorStreamer`) |
| Undo toast | Native **undo** (the rewrite is one undo stop) |
| "Craft a prompt" tab | **Webview panel** (`CraftPanel`) |
| Options page / popup | **`contributes.configuration`** (Settings UI) + **SecretStorage** for the key |
| Reach into ChatGPT/Claude/Gemini | **Chat participant** `@promptmate` for Copilot / Claude *in VS Code* |
| Background service worker | The extension host (always live) — no port indirection |

**Integration with AI agents (Copilot / Claude in VS Code).** Two paths:
- **Chat participant `@promptmate`** — `@promptmate fix my bug` streams back a
  rewritten prompt; `/concise`, `/refine`, `/detail`, `/craft` subcommands map to
  the modes. It runs on `request.model` — the model the user already picked in
  the chat dropdown — so it needs no key and inherits the host agent's auth.
- **`vscode-lm` provider** — the default for commands/webview. It calls
  `vscode.lm.selectChatModels()` to reuse an installed chat model (Copilot,
  Claude). Zero-config for anyone with an agent extension.

**Local vs. remote processing.**
- `vscode-lm` → processed by whichever model extension is installed (no key).
- `anthropic` / `openai` → direct HTTPS from the **extension host** (Node), using
  a key from SecretStorage. Note the browser's
  `anthropic-dangerous-direct-browser-access` header is **dropped** — the host
  has no CORS restriction.
- `proxy` → an OpenAI-wire-format self-hosted endpoint, for fully local/private
  setups.

**Settings & storage.** Non-secret settings come from
`contributes.configuration` (`promptmate.*`), so they show in the native Settings
UI and sync. The API key lives in **`context.secrets`** (OS keychain) — never in
`settings.json`. This is the `chrome.storage.local` → `getConfiguration` +
`SecretStorage` split.

**Version target.** The constraint was 1.80+, but the chat-participant and
`vscode.lm` APIs (the agent-integration requirement) only **stabilized in 1.90**,
so `engines.vscode` is `^1.90.0`. The non-agent core (commands, webview, secrets,
HTTP providers) is 1.80-compatible; dropping `src/chat` and `src/providers/lm.ts`
yields a 1.80 build.

---

## 3. Implementation plan & file map

```
vscode/
  package.json            manifest equivalent — commands, keybindings, menus,
                          chatParticipants, configuration, scripts
  tsconfig.json           strict TS, Node16 modules, ES2022
  .vscodeignore
  src/
    extension.ts          ENTRY POINT — activate/deactivate, wires everything
    shared/types.ts       ported domain types (+ vscode-lm kind, PromptMateError)
    prompt/builder.ts     ported prompt construction (triage/prompt.ts)
    prompt/builder.test.ts unit tests (vitest, as in Chrome project)
    util/rateLimit.ts     ported sliding-window limiter
    config/settings.ts    ConfigProvider: getConfiguration + SecretStorage
    providers/
      provider.ts         Provider interface (AbortSignal → CancellationToken)
      http.ts             shared SSE reader + token→AbortSignal bridge
      anthropic.ts        ported (browser CORS header removed)
      openai.ts           ported (also serves the proxy kind)
      lm.ts               NEW — vscode.lm provider (reuses editor models)
      factory.ts          provider selection + NO_KEY/RATE_LIMIT gating (orchestrator)
    editor/stream.ts      EditorStreamer — streams a rewrite into a tracked range
    commands/enhance.ts   enhance / enhanceWithMode handlers (the wand's onTrigger)
    webview/craftPanel.ts "Craft a prompt" webview (options.ts generation tab)
    chat/participant.ts   @promptmate chat participant (Copilot/Claude integration)
    ui/notify.ts          error → notification mapping (showErrorToast)
    ui/statusBar.ts       status-bar wand (presence + busy spinner)
```

**Build & verify** (already run clean in this folder):
```
npm install
npm run typecheck   # tsc --noEmit — passes
npm run build       # esbuild bundle → dist/extension.js (~27 kb)
npm test            # vitest — 6 passing
```
Press **F5** in VS Code to launch an Extension Development Host.

---

## 4. Code modules

All modules listed above are implemented in `src/`. The four the brief calls out:

- **Entry point** — [src/extension.ts](src/extension.ts): registers commands,
  the chat participant, and the status bar; owns all disposables.
- **Prompt enhancement logic (ported)** — [src/prompt/builder.ts](src/prompt/builder.ts)
  + [src/providers/](src/providers/) (interface, HTTP providers, `lm`, factory).
- **Command handlers for VS Code agents** — [src/commands/enhance.ts](src/commands/enhance.ts)
  and [src/chat/participant.ts](src/chat/participant.ts).
- **Configuration provider** — [src/config/settings.ts](src/config/settings.ts).

### API mapping summary (Chrome → VS Code)

| Chrome API | VS Code equivalent |
|---|---|
| `manifest.json` keys | `package.json` → `contributes` |
| `chrome.commands` | `contributes.commands` + `keybindings` |
| `action.default_popup` / `options_ui` | webview panel + `contributes.configuration` |
| service worker (`background`) | extension host (`activate`) |
| `chrome.runtime.connect` port (streaming) | direct async call + `onDelta` callback |
| content script + site adapters | active editor + chat participant |
| `chrome.storage.local` (settings) | `workspace.getConfiguration` |
| `chrome.storage.local` (apiKey) | `context.secrets` (SecretStorage) |
| `chrome.storage.onChanged` | `workspace.onDidChangeConfiguration` |
| `AbortController` / `AbortSignal` | `CancellationToken` |
| DOM overlay wand + toasts | status-bar item, QuickPick, native notifications, native undo |
| `host_permissions` + CORS header | none — Node `fetch` from the host |
| _(none)_ | `vscode.lm` + chat participant — reuse installed agent models |
```
