/**
 * `promptmate.enhance` / `promptmate.enhanceWithMode` command handlers.
 *
 * This is the VS Code analog of the Chrome wand's `onTrigger`:
 *   findInput()  → the active editor
 *   readPrompt() → the current selection (or the whole document if no selection)
 *   writePrompt()→ streaming EditorStreamer.replace()
 *   mode menu    → a QuickPick
 *   busy wand    → a status-bar/progress spinner
 *   Undo toast   → native undo (the edit is one undo stop)
 */
import * as vscode from "vscode";
import type { ConfigProvider } from "../config/settings";
import type { EnhanceMode } from "../shared/types";
import { resolveProvider } from "../providers/factory";
import { buildSystemPrompt, buildUserMessage } from "../prompt/builder";
import { EditorStreamer } from "../editor/stream";
import { reportError } from "../ui/notify";

const MODES: { id: EnhanceMode; label: string; detail: string }[] = [
  { id: "concise", label: "Concise", detail: "Shorten while keeping intent" },
  { id: "refine", label: "Refine", detail: "Improve clarity & structure" },
  { id: "detail", label: "Detail", detail: "Expand with specifics" },
];

/** Resolve the text to rewrite + the range it occupies in the active editor. */
function resolveTarget(editor: vscode.TextEditor): { text: string; range: vscode.Range } {
  const sel = editor.selection;
  const range = sel.isEmpty
    ? new vscode.Range(
        editor.document.lineAt(0).range.start,
        editor.document.lineAt(editor.document.lineCount - 1).range.end,
      )
    : new vscode.Range(sel.start, sel.end);
  return { text: editor.document.getText(range), range };
}

export async function enhanceCommand(
  config: ConfigProvider,
  chooseMode = false,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("PromptMate: open a file with a prompt first.");
    return;
  }

  const { text, range } = resolveTarget(editor);
  if (!text.trim()) {
    void vscode.window.showInformationMessage("PromptMate: nothing to enhance.");
    return;
  }

  const settings = config.read();
  let mode = settings.defaultMode;
  if (chooseMode) {
    const pick = await vscode.window.showQuickPick(
      MODES.map((m) => ({ label: m.label, detail: m.detail, id: m.id })),
      { placeHolder: "Choose enhancement mode" },
    );
    if (!pick) return; // cancelled
    mode = pick.id;
  }

  const system = buildSystemPrompt(mode, settings.defaultType);
  const user = buildUserMessage(text);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "PromptMate: enhancing…", cancellable: true },
    async (_progress, token) => {
      // Open one undo stop so the entire streamed rewrite reverts with one Ctrl+Z.
      await editor.edit(() => {}, { undoStopBefore: true, undoStopAfter: false });
      const streamer = new EditorStreamer(editor, range, settings.streamIntoEditor);

      try {
        const provider = await resolveProvider(config);
        const full = await provider.stream(system, user, (d) => void streamer.push(d), token);
        await streamer.finalize(full);
      } catch (err) {
        // Roll the original text back, mirroring the Chrome version's rollback.
        await streamer.finalize(text);
        await reportError(err, () => void enhanceCommand(config, chooseMode));
      }
    },
  );
}
