/**
 * Status-bar item — the closest native analog of the Chrome floating "wand".
 * The browser overlay hovered by the prompt box and ran the default mode on
 * click; here a status-bar button does the same, and toggles a spinner while a
 * request is inflight (the wand's `pe-wand--busy` state).
 */
import * as vscode from "vscode";

export class WandStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "promptchef.enhance";
    this.idle();
    this.item.show();
  }

  idle(): void {
    this.item.text = "$(sparkle) Enhance";
    this.item.tooltip = "PromptChef: Enhance Prompt (Ctrl+Shift+E)";
  }

  busy(): void {
    this.item.text = "$(sync~spin) Enhancing…";
    this.item.tooltip = "PromptChef is enhancing your prompt";
  }

  dispose(): void {
    this.item.dispose();
  }
}
