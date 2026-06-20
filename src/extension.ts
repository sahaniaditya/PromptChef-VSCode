/**
 * PromptChef — VS Code extension entry point.
 *
 * This is the analog of the Chrome extension's `service-worker.ts`: it wires up
 * the long-lived pieces (commands, the Activity Bar view, status bar, config)
 * when the host activates, and tears them down on deactivate. Unlike the browser
 * service worker, the extension host is a normal Node process, so there is no
 * message-port indirection — commands call the provider layer directly.
 *
 * Activation: `onStartupFinished` (declared in package.json) so the status-bar
 * wand and panel are ready without blocking editor startup.
 */
import * as vscode from "vscode";
import { ConfigProvider } from "./config/settings";
import { enhanceCommand } from "./commands/enhance";
import { PromptChefViewProvider } from "./webview/craftPanel";
import { WandStatusBar } from "./ui/statusBar";

export function activate(context: vscode.ExtensionContext): void {
  const config = new ConfigProvider(context.secrets);
  const statusBar = new WandStatusBar();
  context.subscriptions.push(statusBar);

  // ── Activity Bar view (Modify / Craft tabs) ────────────────────────────────
  const viewProvider = new PromptChefViewProvider(config);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptChefViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("promptchef.enhance", async () => {
      statusBar.busy();
      try {
        await enhanceCommand(config, false);
      } finally {
        statusBar.idle();
      }
    }),

    vscode.commands.registerCommand("promptchef.enhanceWithMode", async () => {
      statusBar.busy();
      try {
        await enhanceCommand(config, true);
      } finally {
        statusBar.idle();
      }
    }),

    vscode.commands.registerCommand("promptchef.craft", () => viewProvider.reveal()),

    vscode.commands.registerCommand("promptchef.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "PromptChef — API Key",
        prompt: "Stored securely in the OS keychain (SecretStorage), never in settings.json.",
        password: true,
        ignoreFocusOut: true,
      });
      if (key?.trim()) {
        await config.setApiKey(key.trim());
        void vscode.window.showInformationMessage("PromptChef: API key saved.");
      }
    }),

    vscode.commands.registerCommand("promptchef.clearApiKey", async () => {
      await config.clearApiKey();
      void vscode.window.showInformationMessage("PromptChef: API key cleared.");
    }),

    // Copy action invoked from the panel's output (the button shows its own
    // "Copied" confirmation, so no notification toast here).
    vscode.commands.registerCommand("promptchef.copyPrompt", async (text?: string) => {
      if (!text) return;
      await vscode.env.clipboard.writeText(text);
    }),
  );

  // ── Wipe the stored key when the provider changes ──────────────────────────
  // A key belongs to one provider; it must never linger or be reused against a
  // different one. On provider switch we delete the secret and prompt for the
  // new provider's key (for key-based providers).
  const PROVIDER_LABELS: Record<string, string> = {
    "vscode-lm": "VS Code model",
    anthropic: "Anthropic (Claude)",
    openai: "OpenAI",
    gemini: "Gemini",
    proxy: "Proxy",
  };
  let lastProvider = config.read().provider;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("promptchef.provider")) return;
      const next = config.read().provider;
      if (next === lastProvider) return;
      lastProvider = next;

      const hadKey = !!(await config.getApiKey());
      if (hadKey) await config.clearApiKey();

      const label = PROVIDER_LABELS[next] ?? next;
      const needsKey = next === "anthropic" || next === "openai" || next === "gemini";
      if (needsKey) {
        const note = hadKey ? "Previous API key cleared. " : "";
        const pick = await vscode.window.showInformationMessage(
          `PromptChef: switched to ${label}. ${note}Set your ${label} API key.`,
          "Set API Key",
        );
        if (pick === "Set API Key") void vscode.commands.executeCommand("promptchef.setApiKey");
      } else if (hadKey) {
        void vscode.window.showInformationMessage(
          `PromptChef: switched to ${label}. Previous API key cleared.`,
        );
      }
    }),
  );
}

export function deactivate(): void {
  // All disposables are owned by `context.subscriptions`; nothing extra to do.
}
