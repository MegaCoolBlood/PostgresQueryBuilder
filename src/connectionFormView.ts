import * as vscode from 'vscode';

export interface ConnectionFormData {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
}

interface FormDefaults {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
}

export function showConnectionForm(
    context: vscode.ExtensionContext,
    defaults: FormDefaults,
    title: string = 'New PostgreSQL Connection'
): Promise<ConnectionFormData | undefined> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'postgresConnectionForm',
            title,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = buildFormHtml(defaults, title);

        let resolved = false;

        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'save') {
                resolved = true;
                panel.dispose();
                resolve({
                    name: msg.name.trim(),
                    host: msg.host.trim(),
                    port: parseInt(msg.port, 10),
                    database: msg.database.trim(),
                    user: msg.user.trim(),
                    password: msg.password
                });
            } else if (msg.command === 'cancel') {
                resolved = true;
                panel.dispose();
                resolve(undefined);
            }
        });

        panel.onDidDispose(() => {
            if (!resolved) { resolve(undefined); }
        });
    });
}

function esc(value: string | number): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildFormHtml(d: FormDefaults, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px;
    margin: 0;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 20px 0;
    color: var(--vscode-foreground);
  }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    max-width: 560px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .form-group.full-width {
    grid-column: 1 / -1;
  }
  label {
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }
  label .required {
    color: var(--vscode-errorForeground);
    margin-left: 2px;
  }
  input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 6px 8px;
    font-size: 13px;
    font-family: var(--vscode-font-family);
    outline: none;
    border-radius: 2px;
  }
  input:focus {
    border-color: var(--vscode-focusBorder);
  }
  input.error {
    border-color: var(--vscode-inputValidation-errorBorder);
  }
  .hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .actions {
    margin-top: 24px;
    display: flex;
    gap: 8px;
    max-width: 560px;
  }
  button {
    padding: 7px 18px;
    font-size: 13px;
    border: none;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    border-radius: 2px;
  }
  button[type="submit"] {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button[type="submit"]:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button[type="button"] {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button[type="button"]:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .error-msg {
    color: var(--vscode-errorForeground);
    font-size: 12px;
    margin-top: 12px;
    max-width: 560px;
    display: none;
  }
  .divider {
    grid-column: 1 / -1;
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 4px 0;
  }
</style>
</head>
<body>
<h2>${esc(title)}</h2>
<form id="form" novalidate>
  <div class="form-grid">
    <div class="form-group full-width">
      <label for="name">Connection Name <span class="required">*</span></label>
      <input type="text" id="name" value="${esc(d.name)}" placeholder="e.g. My Local DB" autocomplete="off">
    </div>
    <hr class="divider">
    <div class="form-group">
      <label for="host">Host <span class="required">*</span></label>
      <input type="text" id="host" value="${esc(d.host)}" placeholder="localhost" autocomplete="off">
    </div>
    <div class="form-group">
      <label for="port">Port <span class="required">*</span></label>
      <input type="number" id="port" value="${esc(d.port)}" placeholder="5432" min="1" max="65535">
    </div>
    <div class="form-group full-width">
      <label for="database">Database <span class="required">*</span></label>
      <input type="text" id="database" value="${esc(d.database)}" placeholder="postgres" autocomplete="off">
    </div>
    <hr class="divider">
    <div class="form-group">
      <label for="user">Username <span class="required">*</span></label>
      <input type="text" id="user" value="${esc(d.user)}" placeholder="postgres" autocomplete="username">
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" value="${esc(d.password)}" placeholder="(leave empty if none)" autocomplete="current-password">
      <span class="hint">Stored securely in VS Code Secret Storage</span>
    </div>
  </div>
  <div class="error-msg" id="errorMsg"></div>
  <div class="actions">
    <button type="submit">Save &amp; Connect</button>
    <button type="button" id="cancelBtn">Cancel</button>
  </div>
</form>
<script>
  const vscode = acquireVsCodeApi();

  document.getElementById('cancelBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'cancel' });
  });

  document.getElementById('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const host = document.getElementById('host').value.trim();
    const port = document.getElementById('port').value.trim();
    const database = document.getElementById('database').value.trim();
    const user = document.getElementById('user').value.trim();
    const password = document.getElementById('password').value;

    // Basic validation
    const errors = [];
    if (!name) errors.push('Connection Name is required');
    if (!host) errors.push('Host is required');
    if (!port || isNaN(parseInt(port))) errors.push('Port must be a valid number');
    if (!database) errors.push('Database is required');
    if (!user) errors.push('Username is required');

    const errorMsg = document.getElementById('errorMsg');
    if (errors.length > 0) {
      errorMsg.textContent = errors.join('. ');
      errorMsg.style.display = 'block';
      return;
    }
    errorMsg.style.display = 'none';

    vscode.postMessage({ command: 'save', name, host, port, database, user, password });
  });

  // Focus first input
  document.getElementById('name').focus();
</script>
</body>
</html>`;
}
