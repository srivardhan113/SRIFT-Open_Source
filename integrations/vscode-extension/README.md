# VS Code extension snippet

A minimal extension that adds a **"Send via SRIFT"** right-click action.

```ts
// extension.ts
import * as vscode from "vscode";

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.commands.registerCommand("srift.share", async (uri: vscode.Uri) => {
    const r = await fetch("http://127.0.0.1:3822/quick-share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: uri.fsPath }),
    });
    const { shareUrl } = await r.json();
    await vscode.env.clipboard.writeText(shareUrl);
    vscode.window.showInformationMessage(`SRIFT share URL copied: ${shareUrl}`);
  }));
}
```

`package.json`:
```json
{
  "contributes": {
    "commands": [{ "command": "srift.share", "title": "Send via SRIFT" }],
    "menus": { "explorer/context": [{ "command": "srift.share", "group": "navigation" }] }
  }
}
```

GitHub Copilot Chat tool: register `srift_quick_share` as a custom tool in `participants` (Copilot
extension API).
