/**
 * Configuration provider.
 *
 * Chrome → VS Code mapping:
 *   chrome.storage.local (settings) → vscode.workspace.getConfiguration('promptmate')
 *   chrome.storage.local (apiKey)   → context.secrets (SecretStorage)
 *
 * Non-secret settings come from `contributes.configuration` so they appear in
 * the native Settings UI and sync across machines. The API key is kept in the
 * OS keychain via SecretStorage and is never written to settings.json.
 */
import * as vscode from "vscode";
import type { EnhanceMode, ProviderKind, PromptType, Settings } from "../shared/types";

const SECTION = "promptmate";
const SECRET_KEY = "promptmate.apiKey";

export class ConfigProvider {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Reads the current non-secret settings. */
  read(): Settings {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
      provider: cfg.get<ProviderKind>("provider", "vscode-lm"),
      model: cfg.get<string>("model", "claude-haiku-4-5-20251001"),
      proxyUrl: cfg.get<string>("proxyUrl") || undefined,
      defaultMode: cfg.get<EnhanceMode>("defaultMode", "refine"),
      defaultType: cfg.get<PromptType>("defaultType", "coding"),
      streamIntoEditor: cfg.get<boolean>("streamIntoEditor", true),
    };
  }

  /** Persists a single setting at the global (user) level. */
  async update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  getApiKey(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  setApiKey(key: string): Thenable<void> {
    return this.secrets.store(SECRET_KEY, key);
  }

  clearApiKey(): Thenable<void> {
    return this.secrets.delete(SECRET_KEY);
  }

  /**
   * Fires when relevant configuration changes, so long-lived UI (the Craft
   * webview, status bar) can refresh. Mirrors the Chrome `storage.onChanged`
   * listener in `injector.ts`.
   */
  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) listener();
    });
  }
}
