# MyCompanies Runner CLI

`mycompanies-runner` is the standalone Node.js client for the MyCompanies Runner API. It has its own public GitHub repository so releases and npm publication are independent from the Laravel server.

- npm package: `mycompanies-runner`
- terminal command: `mycompany`
- Node.js: 20 or newer
- Runtime dependencies: none
- License: MIT

## Install

Once published to npm:

```sh
npm install --global mycompanies-runner
```

Until then, install directly from GitHub:

```sh
npm install --global github:PabloTheBlink/company-runner
```

## Select a company from the current folder

Each local workspace folder is enrolled separately. Run `enroll` from that folder; no path argument is needed:

```sh
cd /path/to/company/workspace
mycompany enroll --server=https://YOUR-MYCOMPANIES-HOST
```

Enter the one-time code from the MyCompanies Runners page when prompted. The prompt hides the code. The current folder is checked locally and is never sent to the server. For local development only, HTTP is allowed for `localhost`, `127.0.0.1`, or `::1` with `--allow-insecure-localhost`; network hosts require HTTPS.

Later, run commands from that workspace or any folder inside it:

```sh
mycompany heartbeat
mycompany work
mycompany tasks
mycompany task 42
mycompany forget
```

With several enrolled folders, the CLI selects the credential whose workspace contains the current directory. If workspace folders are nested, the most specific match wins. The heartbeat confirms the selected company and Runner by name. If no folder matches, the command stops without contacting the server. `forget` removes only the credential selected for the current folder; revoke it from MyCompanies first to invalidate it immediately.

`mycompany work` makes one request for an explicitly authorized read-only workspace check. It does not poll continuously, run shell commands, execute scripts, or send local paths. Unknown capabilities are rejected.

`mycompany tasks` lists up to 100 active tasks from every workspace currently assigned to the selected Runner. It shows each task's title, status, priority, due date, and workspace; it does not download descriptions or execute tasks. Tasks in unassigned workspaces, tasks without a workspace, and completed or cancelled tasks are excluded. If the server reports more than 100 active tasks, the CLI says so.

`mycompany task ID` shows the description and details for one active task, if its workspace is currently assigned to the selected Runner. The endpoint returns `404` for tasks outside that scope, completed tasks, and unknown IDs. The command prints the text for a person to review; it does not interpret or execute it.

## Credential storage

Each enrollment is stored as a separate JSON file under the user's private configuration directory:

- Linux: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/.config/mycompanies/runners/`
- macOS: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/Library/Application Support/mycompanies/runners/`
- Windows: `%APPDATA%\mycompanies\runners\`

On Linux and macOS, the directory is restricted to mode `0700` and files to `0600`. On Windows files use the current user's AppData access controls. The CLI rejects symlinks for credential paths and will not overwrite an existing Runner enrollment. It can still read the earlier single-runner file `runner.json`.

## Scope and security

This release supports one-time enrollment, manual heartbeat, a fixed read-only workspace check, and read-only task listing/detail. It does not poll, access repositories, run scripts, or execute code received from the server. It opens no inbound ports. Runner credentials are revocable from MyCompanies; local workspace paths and tool secrets are not uploaded. HTTP redirects are not followed, response size is bounded, and error messages avoid returning response bodies or credentials.

The server-side contract and future execution boundaries are documented in [MyCompanies' Runner protocol](https://github.com/PabloTheBlink/mycompanies/blob/main/docs/runner-protocol.md).

## Development and release

```sh
npm test
node --check src/cli.js
npm pack --dry-run
```

To release, update `version` in `package.json`, run the checks above, commit and push the version, then authenticate to npm and publish:

```sh
npm login
npm publish
```

The npm account must own or have publish access to the unscoped package name `mycompanies-runner`. GitHub pushes do not publish the package to npm.
