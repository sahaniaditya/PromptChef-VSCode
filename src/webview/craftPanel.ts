/**
 * PromptMate view — an Activity Bar webview with two tabs:
 *
 *   • Modify — refine an existing prompt along one dimension (Concise / Clarity /
 *     Detail = the `concise` / `refine` / `detail` EnhanceModes). Seeded with the
 *     active editor's selection so it isn't a blank box.
 *   • Craft  — generate a brand-new prompt from a description.
 *
 * Each tab has its OWN output + Copy button, so results are preserved
 * independently and switching tabs never clobbers the other tab's result.
 * Streamed chunks carry a `genId` so they always land in the tab that started
 * the generation, even if the user switches tabs mid-stream.
 *
 * The webview never holds an API key or makes network calls — the extension
 * host runs the provider on its behalf and bridges the boundary with postMessage.
 *
 * Message protocol
 *   webview → host: { type: "enhance", genId, mode, promptType, text }
 *                 | { type: "generate", genId, params }
 *                 | { type: "copy" | "insert", text }
 *   host → webview: { type: "delta", genId, text } | { type: "done", genId, text }
 *                 | { type: "error", genId, message } | { type: "seed", text }
 */
import * as vscode from "vscode";
import type { ConfigProvider } from "../config/settings";
import type { EnhanceMode, GenerateParams, PromptType, ProviderKind } from "../shared/types";
import { resolveProvider } from "../providers/factory";
import {
  buildGenerateSystemPrompt,
  buildGenerateUserMessage,
  buildSystemPrompt,
  buildUserMessage,
} from "../prompt/builder";
import { PromptMateError } from "../shared/types";

interface InboundMessage {
  type:
    | "enhance"
    | "generate"
    | "copy"
    | "insert"
    | "getSettings"
    | "saveSettings"
    | "saveKey"
    | "clearKey";
  genId?: number;
  mode?: EnhanceMode;
  promptType?: PromptType;
  text?: string;
  params?: GenerateParams;
  provider?: ProviderKind;
  model?: string;
  proxyUrl?: string;
}

export class PromptMateViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "promptmate.panelView";

  private view?: vscode.WebviewView;
  private cancel?: vscode.CancellationTokenSource;

  constructor(private readonly config: ConfigProvider) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m));
    // Re-seed when the panel becomes visible again (the webview only applies it
    // when its Modify box is empty, so it never clobbers in-progress text).
    view.onDidChangeVisibility(() => view.visible && this.seedFromEditor());
    // Keep the Settings tab in sync if config changes elsewhere (e.g. native
    // Settings UI, or the provider-switch key wipe in extension.ts).
    this.config.onDidChange(() => void this.postSettings());
    this.seedFromEditor();
    void this.postSettings();
  }

  /** Reveal the view (Activity Bar) and seed the Modify box from the selection. */
  async reveal(): Promise<void> {
    this.seedFromEditor();
    await vscode.commands.executeCommand("promptmate.panelView.focus");
    this.seedFromEditor();
  }

  private seedFromEditor(): void {
    const editor = vscode.window.activeTextEditor;
    const text =
      editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
    if (text) void this.view?.webview.postMessage({ type: "seed", text });
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "copy":
        if (msg.text) await vscode.commands.executeCommand("promptmate.copyPrompt", msg.text);
        return;
      case "insert":
        if (msg.text) {
          const doc = await vscode.workspace.openTextDocument({ content: msg.text, language: "markdown" });
          await vscode.window.showTextDocument(doc);
        }
        return;
      case "enhance":
        if (msg.text?.trim() && msg.mode) {
          await this.runEnhance(msg.mode, msg.text, msg.promptType, msg.genId ?? 0);
        }
        return;
      case "generate":
        if (msg.params) await this.runGenerate(msg.params, msg.genId ?? 0);
        return;
      case "getSettings":
        await this.postSettings();
        return;
      case "saveSettings":
        await this.saveSettings(msg.provider, msg.model, msg.proxyUrl);
        return;
      case "saveKey":
        if (msg.text?.trim()) await this.config.setApiKey(msg.text.trim());
        await this.postSettings();
        return;
      case "clearKey":
        await this.config.clearApiKey();
        await this.postSettings();
        return;
    }
  }

  /** Persist provider/model/proxy; wipe the key if the provider changed. */
  private async saveSettings(
    provider: ProviderKind | undefined,
    model: string | undefined,
    proxyUrl: string | undefined,
  ): Promise<void> {
    const prev = this.config.read().provider;
    if (provider) await this.config.update("provider", provider);
    if (model !== undefined) await this.config.update("model", model);
    if (proxyUrl !== undefined) await this.config.update("proxyUrl", proxyUrl || undefined);
    // A key belongs to one provider — switching invalidates it (the global
    // watcher in extension.ts also enforces this; doing it here keeps the panel
    // immediately consistent).
    if (provider && provider !== prev) await this.config.clearApiKey();
    await this.postSettings();
  }

  /** Send current (non-secret) settings + whether a key is stored to the webview. */
  private async postSettings(): Promise<void> {
    const s = this.config.read();
    const keyPresent = !!(await this.config.getApiKey());
    void this.view?.webview.postMessage({
      type: "settings",
      provider: s.provider,
      model: s.model,
      proxyUrl: s.proxyUrl ?? "",
      keyPresent,
    });
  }

  private async runEnhance(
    mode: EnhanceMode,
    text: string,
    promptType: PromptType | undefined,
    genId: number,
  ): Promise<void> {
    const type = promptType ?? this.config.read().defaultType;
    const system = buildSystemPrompt(mode, type);
    await this.stream(system, buildUserMessage(text), genId);
  }

  private async runGenerate(params: GenerateParams, genId: number): Promise<void> {
    await this.stream(buildGenerateSystemPrompt(params), buildGenerateUserMessage(params), genId);
  }

  /** Runs the configured provider and bridges deltas/result/errors to the webview. */
  private async stream(system: string, user: string, genId: number): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    this.cancel?.cancel();
    this.cancel = new vscode.CancellationTokenSource();
    try {
      const provider = await resolveProvider(this.config);
      const full = await provider.stream(
        system,
        user,
        (text) => void webview.postMessage({ type: "delta", genId, text }),
        this.cancel.token,
      );
      void webview.postMessage({ type: "done", genId, text: full });
    } catch (err) {
      const message =
        err instanceof PromptMateError ? err.message : err instanceof Error ? err.message : String(err);
      void webview.postMessage({ type: "error", genId, message });
    }
  }

  private html(_webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const settings = this.config.read();
    const defaultMode = settings.defaultMode;
    const defaultType = settings.defaultType;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  label { display:block; margin: 10px 0 4px; font-size: 12px; opacity: .85; }
  textarea, select, input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; border-radius: 4px; }
  .hint { font-size: 11px; opacity: .7; margin-top: 6px; }
  .hint a { color: var(--vscode-textLink-foreground); }
  .row { display:flex; gap: 8px; flex-wrap: wrap; } .row > div { flex: 1; min-width: 90px; }
  button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .5; cursor: default; }

  .tabs { display:flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  .tab { background: transparent; color: var(--vscode-foreground); border-radius: 0; padding: 8px 14px;
    border-bottom: 2px solid transparent; opacity: .7; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
  .view { display:none; } .view.active { display:block; }

  .seg { display:flex; margin: 6px 0 4px; }
  .seg button { border-radius: 0; background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); border-left: none; }
  .seg button:first-child { border-left: 1px solid var(--vscode-panel-border); border-radius: 4px 0 0 4px; }
  .seg button:last-child { border-radius: 0 4px 4px 0; }
  .seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  .primary-row { margin-top: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background);
    padding: 12px; border-radius: 4px; margin-top: 16px; min-height: 40px; }
  pre.streaming { opacity: .92; }
  .caret { display:none; width: 7px; height: 1em; background: var(--vscode-foreground);
    vertical-align: text-bottom; margin-left: 1px; animation: blink 1s step-start infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .outtext.placeholder { opacity: .6; font-style: italic; }
  .actions { display:flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .err { color: var(--vscode-errorForeground); margin-top: 8px; min-height: 16px; }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="modify">Modify</button>
    <button class="tab" data-tab="craft">Craft</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div class="view active" id="view-modify">
    <label for="mtext">Prompt to improve</label>
    <textarea id="mtext" rows="4" placeholder="Paste or type the prompt you want to refine…"></textarea>
    <label>Dimension</label>
    <div class="seg" id="seg">
      <button data-mode="concise">Concise</button>
      <button data-mode="refine">Clarity</button>
      <button data-mode="detail">Detail</button>
    </div>
    <label for="mtype">Type</label>
    <select id="mtype">
      <option value="coding">Coding</option><option value="marketing">Marketing</option>
      <option value="research">Research</option><option value="education">Education</option>
      <option value="professional">Professional</option><option value="general">General</option>
      <option value="personal">Personal</option>
    </select>
    <div class="primary-row"><button id="enhance">Enhance</button></div>
    <pre id="m-out"><span class="outtext" id="m-outtext"></span><span class="caret" id="m-caret"></span></pre>
    <div class="actions"><button id="m-copy" class="secondary" disabled>Copy</button></div>
    <div class="err" id="m-err"></div>
  </div>

  <div class="view" id="view-craft">
    <label for="desc">Describe the prompt you want</label>
    <textarea id="desc" rows="3" placeholder="e.g. a code reviewer that checks for security issues"></textarea>
    <div class="row">
      <div>
        <label for="type">Type</label>
        <select id="type">
          <option value="coding">Coding</option><option value="marketing">Marketing</option>
          <option value="research">Research</option><option value="education">Education</option>
          <option value="professional">Professional</option><option value="general" selected>General</option>
          <option value="personal">Personal</option>
        </select>
      </div>
      <div>
        <label for="length">Length</label>
        <select id="length"><option value="short">Short</option><option value="moderate" selected>Moderate</option><option value="long">Long</option></select>
      </div>
      <div>
        <label for="tone">Tone</label>
        <select id="tone"><option value="professional" selected>Professional</option><option value="formal">Formal</option>
          <option value="casual">Casual</option><option value="friendly">Friendly</option>
          <option value="persuasive">Persuasive</option><option value="technical">Technical</option></select>
      </div>
    </div>
    <div class="primary-row"><button id="gen">Generate prompt</button></div>
    <pre id="c-out"><span class="outtext" id="c-outtext"></span><span class="caret" id="c-caret"></span></pre>
    <div class="actions"><button id="c-copy" class="secondary" disabled>Copy</button></div>
    <div class="err" id="c-err"></div>
  </div>

  <div class="view" id="view-settings">
    <label for="provider">LLM provider</label>
    <select id="provider">
      <option value="vscode-lm">VS Code model (no key)</option>
      <option value="anthropic">Anthropic (Claude)</option>
      <option value="openai">OpenAI</option>
      <option value="gemini">Gemini</option>
      <option value="proxy">Proxy (OpenAI-compatible)</option>
    </select>

    <label for="smodel">Model</label>
    <input id="smodel" type="text" placeholder="e.g. claude-haiku-4-5-20251001" />
    <div class="hint">
      Find model ids:
      <a href="https://docs.anthropic.com/en/docs/about-claude/models/overview">Anthropic</a> ·
      <a href="https://platform.openai.com/docs/models">OpenAI</a> ·
      <a href="https://ai.google.dev/gemini-api/docs/models">Gemini</a>
    </div>

    <div id="proxy-row" style="display:none">
      <label for="sproxy">Proxy URL</label>
      <input id="sproxy" type="text" placeholder="https://…/v1/chat/completions" />
    </div>

    <div class="primary-row"><button id="save-settings">Save provider & model</button></div>
    <div class="hint" id="settings-status"></div>

    <div id="key-section">
      <label for="skey">API key</label>
      <input id="skey" type="password" placeholder="Paste your API key" />
      <div class="actions">
        <button id="save-key">Save key</button>
        <button id="clear-key" class="secondary">Clear key</button>
      </div>
      <div class="hint" id="key-status">No key set.</div>
      <div class="hint">Stored in the OS keychain (SecretStorage), never in settings.json.</div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let mode = ${JSON.stringify(defaultMode)};

  // Preselect the Modify tab's Type from the configured default.
  $("mtype").value = ${JSON.stringify(defaultType)};

  // Tabs — purely show/hide; each tab keeps its own output, so nothing is reset.
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("view-" + t.dataset.tab).classList.add("active");
  }));

  // Segmented mode control
  function paintSeg() {
    document.querySelectorAll("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  }
  document.querySelectorAll("#seg button").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.mode; paintSeg(); }));
  paintSeg();

  // ── Settings tab ──────────────────────────────────────────────────────────
  function applyProviderUI() {
    const p = $("provider").value;
    $("proxy-row").style.display = p === "proxy" ? "block" : "none";
    const needsKey = p === "anthropic" || p === "openai" || p === "gemini" || p === "proxy";
    $("key-section").style.display = needsKey ? "block" : "none";
  }
  function applySettings(m) {
    $("provider").value = m.provider;
    $("smodel").value = m.model || "";
    $("sproxy").value = m.proxyUrl || "";
    $("key-status").textContent = m.keyPresent ? "✓ API key saved." : "No key set.";
    applyProviderUI();
  }
  $("provider").addEventListener("change", applyProviderUI);
  $("save-settings").addEventListener("click", () => {
    vscode.postMessage({ type: "saveSettings",
      provider: $("provider").value, model: $("smodel").value.trim(), proxyUrl: $("sproxy").value.trim() });
    $("settings-status").textContent = "Saved.";
    setTimeout(() => { $("settings-status").textContent = ""; }, 1500);
  });
  $("save-key").addEventListener("click", () => {
    const k = $("skey").value.trim();
    if (!k) { $("key-status").textContent = "Enter a key first."; return; }
    vscode.postMessage({ type: "saveKey", text: k });
    $("skey").value = "";
    $("key-status").textContent = "✓ API key saved.";
  });
  $("clear-key").addEventListener("click", () => {
    vscode.postMessage({ type: "clearKey" });
    $("skey").value = "";
    $("key-status").textContent = "No key set.";
  });
  vscode.postMessage({ type: "getSettings" });

  // One self-contained output controller per tab (its own DOM + streaming state).
  function makeController(prefix, runBtn) {
    const out = $(prefix + "out"), outtext = $(prefix + "outtext"), caret = $(prefix + "caret");
    const copy = $(prefix + "copy"), err = $(prefix + "err");
    const st = { result: "", pending: "", finished: false, busy: false, pump: null, copyT: null };

    function render() {
      if (st.result) { outtext.textContent = st.result; outtext.classList.remove("placeholder"); }
      else if (st.busy) { outtext.textContent = "Generating…"; outtext.classList.add("placeholder"); }
      else { outtext.textContent = ""; outtext.classList.remove("placeholder"); }
      caret.style.display = st.busy ? "inline-block" : "none";
      out.classList.toggle("streaming", st.busy);
      copy.disabled = !(st.result && !st.busy);
    }
    function stopPump() { if (st.pump) { clearInterval(st.pump); st.pump = null; } }
    // Reveal buffered text at a steady rate so it visibly streams even when the
    // provider delivers everything in one chunk.
    function pump() {
      if (st.pending.length) {
        const n = Math.max(1, Math.ceil(st.pending.length / 40));
        st.result += st.pending.slice(0, n); st.pending = st.pending.slice(n); render();
      } else if (st.finished) {
        stopPump(); st.busy = false; render(); runBtn.disabled = false;
      }
    }
    function startPump() { if (!st.pump) st.pump = setInterval(pump, 16); }

    copy.addEventListener("click", () => {
      if (!st.result) return;
      vscode.postMessage({ type: "copy", text: st.result });
      copy.textContent = "Copied";
      clearTimeout(st.copyT);
      st.copyT = setTimeout(() => { copy.textContent = "Copy"; }, 1200);
    });

    return {
      setError(msg) { err.textContent = msg; },
      begin() {
        stopPump();
        st.result = ""; st.pending = ""; st.finished = false; st.busy = true; err.textContent = "";
        runBtn.disabled = true; render();
      },
      onDelta(t) { st.pending += t; startPump(); },
      onDone(full) {
        const f = (typeof full === "string" && full.length) ? full : st.result + st.pending;
        st.pending = f.slice(st.result.length); st.finished = true; startPump();
      },
      onError(msg) { stopPump(); st.busy = false; st.finished = true; render(); err.textContent = msg; runBtn.disabled = false; },
    };
  }

  const modifyCtrl = makeController("m-", $("enhance"));
  const craftCtrl = makeController("c-", $("gen"));

  // Each generation gets an id; streamed chunks route to the controller that
  // started it, so switching tabs mid-stream never crosses the wires.
  let genId = 0;
  let current = null; // { id, ctrl }
  function run(ctrl, message) {
    genId++;
    current = { id: genId, ctrl };
    ctrl.begin();
    message.genId = genId;
    vscode.postMessage(message);
  }

  $("enhance").addEventListener("click", () => {
    const text = $("mtext").value.trim();
    if (!text) { modifyCtrl.setError("Enter a prompt to improve."); return; }
    run(modifyCtrl, { type: "enhance", mode, text, promptType: $("mtype").value });
  });

  $("gen").addEventListener("click", () => {
    const description = $("desc").value.trim();
    if (!description) { craftCtrl.setError("Describe what the prompt should be about."); return; }
    run(craftCtrl, { type: "generate", params: {
      description, promptType: $("type").value, length: $("length").value, tone: $("tone").value,
    }});
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "seed") { if (m.text && !$("mtext").value) $("mtext").value = m.text; return; }
    if (m.type === "settings") { applySettings(m); return; }
    if (!current || m.genId !== current.id) return; // stale / unknown generation
    if (m.type === "delta") current.ctrl.onDelta(m.text);
    else if (m.type === "done") current.ctrl.onDone(m.text);
    else if (m.type === "error") current.ctrl.onError(m.message);
  });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
