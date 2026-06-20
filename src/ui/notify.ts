/**
 * Maps typed errors to native notifications with the right follow-up action —
 * the VS Code analog of the Chrome `showErrorToast` (which linked to settings
 * for NO_KEY and offered Retry otherwise).
 */
import * as vscode from "vscode";
import { PromptMateError, type ErrorCode } from "../shared/types";

const FRIENDLY: Record<ErrorCode, string> = {
  NO_KEY: "No API key set.",
  NO_MODEL: "No language model available.",
  BAD_MODEL: "The configured model id looks wrong.",
  RATE_LIMIT: "Too many requests. Wait a moment and try again.",
  NETWORK: "Couldn't reach the model provider.",
  PARSE_ERROR: "Couldn't parse the model response.",
  ABORT: "Cancelled.",
  UNKNOWN: "Couldn't enhance the prompt.",
};

export async function reportError(err: unknown, onRetry?: () => void): Promise<void> {
  const code: ErrorCode = err instanceof PromptMateError ? err.code : "UNKNOWN";
  if (code === "ABORT") return; // user-initiated cancellation — stay quiet

  const detail = err instanceof Error ? err.message : String(err);
  const message = `PromptChef: ${FRIENDLY[code]}`;

  if (code === "NO_KEY") {
    const pick = await vscode.window.showErrorMessage(message, "Set API Key");
    if (pick === "Set API Key") void vscode.commands.executeCommand("promptchef.setApiKey");
    return;
  }
  if (code === "NO_MODEL" || code === "BAD_MODEL") {
    // BAD_MODEL carries the offending id + docs link in `detail`; show it.
    const text = code === "BAD_MODEL" ? `${message} (${detail})` : message;
    const pick = await vscode.window.showErrorMessage(text, "Open Settings");
    if (pick === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "promptchef.model");
    }
    return;
  }

  const actions = onRetry ? ["Retry"] : [];
  const pick = await vscode.window.showErrorMessage(`${message} (${detail})`, ...actions);
  if (pick === "Retry") onRetry?.();
}
