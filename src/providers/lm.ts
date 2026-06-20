/**
 * VS Code Language Model provider — NET-NEW for the VS Code port; it has no
 * Chrome equivalent.
 *
 * Instead of calling an HTTP API with the user's own key, this reuses a chat
 * model already registered in the editor (Copilot, Claude in VS Code, …) via
 * the `vscode.lm` API. That means PromptMate works with zero configuration for
 * anyone who already has an AI agent extension installed, and the request is
 * billed/authenticated through that extension.
 *
 * The LM API has only User/Assistant message roles (no system role), so we fold
 * the system prompt into a leading user message — the same technique the API
 * docs recommend.
 */
import * as vscode from "vscode";
import type { Provider } from "./provider";
import { PromptMateError } from "../shared/types";

/**
 * Resolves a chat model. `modelHint` is matched loosely against the model
 * `family` and `id` (e.g. "claude", "gpt-4o", "haiku"); if nothing matches we
 * fall back to the first Copilot model available.
 */
async function selectModel(modelHint: string): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels();
  if (all.length === 0) {
    throw new PromptMateError(
      "NO_MODEL",
      "No language model is available. Install GitHub Copilot or Claude for VS Code, " +
        "or switch PromptMate's provider to Anthropic/OpenAI in Settings.",
    );
  }
  const hint = modelHint.trim().toLowerCase();
  const match =
    (hint &&
      all.find(
        (m) => m.id.toLowerCase().includes(hint) || m.family.toLowerCase().includes(hint),
      )) ||
    all.find((m) => m.vendor === "copilot") ||
    all[0];
  return match;
}

export function makeLmProvider(modelHint: string): Provider {
  return {
    async stream(system, user, onDelta, token): Promise<string> {
      const model = await selectModel(modelHint);
      const messages = [
        // Fold the system prompt into the first user turn (no system role here).
        vscode.LanguageModelChatMessage.User(`${system}\n\n${user}`),
      ];

      let response: vscode.LanguageModelChatResponse;
      try {
        response = await model.sendRequest(messages, {}, token);
      } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
          throw new PromptMateError("NETWORK", `${err.code}: ${err.message}`);
        }
        throw err;
      }

      let full = "";
      for await (const fragment of response.text) {
        full += fragment;
        onDelta(fragment);
      }
      return full;
    },
  };
}
