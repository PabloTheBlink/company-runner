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

Each local company root is enrolled separately. It may contain several logical MyCompanies Workspaces and project repositories. Run `init` and `enroll` from the company root; no path argument is needed:

```sh
cd /path/to/company
mycompany init
mycompany enroll --server=https://YOUR-MYCOMPANIES-HOST
```

`mycompany init` is a local-only, repeatable setup command. It creates `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code, and the fixed company-root layout: `agents/`, `architecture/`, `tasks/`, `automations/<id>/`, `reports/<id>/`, and `.mycompanies/`. It adds or refreshes only a clearly marked MyCompanies instruction block in those guidance files, preserves text outside the block, and never deletes existing files. It refuses symbolic-link targets and malformed managed blocks before writing anything. It makes no API calls and does not inspect environment files.

The generated guidance keeps personal work, AI-assisted work with optional subagents, and recurring local scripts distinct. MyCompanies stores company-scoped agent profiles with stable identity, a flexible role label, initial instructions, and active/paused state. Owners/admins can record and revoke capability grants; changes are audited, and task grants can be limited to a Workspace. Each agent runtime can have a separately named, revocable Bearer credential; only its hash is stored and the secret is shown once. The versioned Agent API exposes the authenticated agent's identity and active grants, task list/detail, task creation, status changes and limited detail edits with `tasks.manage`, assignment with the separate `tasks.assign` grant, and read-only bet list/detail with `bets.read` or `bets.manage`, and evidence recording with `bets.manage`, plus bet status transitions with the separate `bets.status.manage` grant. An agent with `agents.permissions.manage` may grant only permissions it holds to active direct reports, at the same or narrower scope; grants retain their source. Agent API or owner/admin revocation cascades to active descendant grants, with each event attributed to the actor. Pausing an agent profile also revokes delegated descendants but preserves its own grants; reactivating it does not restore those descendant grants. Revoking one runtime credential does not affect other credentials for the same profile. Regranting a revoked permission does not restore descendants. Task reads accept `tasks.read` or `tasks.manage`; bet reads accept `bets.read` or `bets.manage`, while adding evidence requires `bets.manage` and status changes require `bets.status.manage`. Task creation starts tasks as open and unassigned, records the agent in status history, validates Workspace scope, and requires an `Idempotency-Key` UUID to make retries safe. A repeated key with the same payload returns the original task; a changed payload returns conflict. Status changes record their agent actor, honor task dependencies, and do not produce duplicate history when the requested status is already set. Detail edits are limited to title, description, priority, and due date; before/after differences are recorded and edits cannot change status, assignee, or Workspace. Assignment records the delegating agent; the assignee must be active and have `tasks.read` for the task's company or Workspace. `tasks.manage` does not imply `tasks.assign`, and reporting hierarchy or a CEO title gives no authorization. Paused agents, revoked credentials, and out-of-scope tasks are rejected. These credentials are separate from Runner credentials. The CLI can validate an Agent credential, query identity/grants, and list tasks within the active Agent grant scope; the CLI can create and assign tasks, request status transitions, edit task details, and read company bets and evidence and record bet evidence under `bets.manage` and change bet status under `bets.status.manage`. Agent APIs cannot edit profiles or execute local actions. Agents can record evidence on company bets with `bets.manage`; this stores an identity snapshot and an assessment as an observation without changing bet status or converting the bet into an offer. Other business grants do not yet have effective Agent API operations. Local profile snapshots use `agents/<agent-id>/instructions.md`, with skills under `agents/<agent-id>/skills/`; `mycompany init` does not create or fetch those profiles. Skills and instructions can currently be copied manually, but there is no background sync. A future explicit `mycompany sync` will materialize server-managed data and report local conflicts; `mycompany update` will update the CLI package separately.

MyCompanies will own company/workspace data, human and agent identities, permissions, tasks, bets, offers, and schedules. The company root remains the source for repositories, scripts, secrets, and skill contents. A logical Workspace may be linked to a local folder or repo explicitly, but it is never assumed to be one physical directory.

Enter the one-time code from the MyCompanies Runners page when prompted. The prompt hides the code. The current folder is checked locally and is never sent to the server. For local development only, HTTP is allowed for `localhost`, `127.0.0.1`, or `::1` with `--allow-insecure-localhost`; network hosts require HTTPS. Use `mycompany help` for a Spanish description of each command, its local or server effects, and its current limits.

Later, run commands from that company root or any folder inside it:

```sh
mycompany heartbeat
mycompany work
mycompany tasks
mycompany task 42
mycompany forget
```

With several enrolled folders, the CLI selects the credential whose company root contains the current directory. If company roots are nested, the most specific match wins. The heartbeat confirms the selected company and Runner by name. If no folder matches, the command stops without contacting the server. `forget` removes only the credential selected for the current folder; revoke it from MyCompanies first to invalidate it immediately.

`mycompany work` makes one request for an explicitly authorized read-only workspace check. It does not poll continuously, run shell commands, execute scripts, or send local paths. Unknown capabilities are rejected.

`mycompany tasks` lists up to 100 active tasks from every workspace currently assigned to the selected Runner. It shows each task's title, status, priority, due date, workspace, and responsible person's or agent profile's name. This is the current assignment only; the CLI does not read assignment history. The identity is informational; the Runner does not become that agent or gain its permissions. The list does not download descriptions or execute tasks. Tasks in unassigned workspaces, tasks without a workspace, and completed or cancelled tasks are excluded. If there are more results, continue with the `--after` ID shown by the CLI, for example `mycompany tasks --after=100`.

When no responsible identity is assigned, the CLI prints `responsable sin asignar`.

`mycompany task ID` shows the description, responsible identity, and details for one active task, if its workspace is currently assigned to the selected Runner. The endpoint returns `404` for tasks outside that scope, completed tasks, and unknown IDs. The command prints the text for a person to review; it does not interpret or execute it.

## Publish and retrieve company reports

An Agent with `artifacts.publish` can publish one explicitly selected report from the company folder. The server stores a private copy; the source file remains local:

```sh
mycompany artifact publish reports/daily.md --title="Informe diario" --source="daily-report"
mycompany artifacts
mycompany artifact download 42 --output=reports/shared-copy.md
```

The Dev.to analytics script in the Devetty example keeps its default local-only behavior. To generate and share its report in one explicit action, run `python3 automations/devto/devto_stats.py report --publish` from the company root. The script first saves the report locally, then invokes the CLI with that exact report path. It requires an active Agent CLI credential with `artifacts.publish`.

Only `.md`, `.txt`, and `.pdf` files up to 10 MiB are accepted. The CLI rejects symlinks and paths outside the selected company root. Downloads must target a new path under that root and are created with owner-only file permissions on Unix. `artifacts.read` allows listing and downloading; `artifacts.publish` also includes read access. Human company members can browse and download the same reports in the web app. The feature publishes individual files; it does not sync folders, run schedules, or execute scripts.

## Codex and Claude Code in a company folder

You can start Codex or Claude Code manually from a company root after reviewing that company's `AGENTS.md` or `CLAUDE.md`. The CLI can separately authenticate as a MyCompanies Agent and show its server identity and active grants. It does not launch an assistant or execute Agent tasks. A profile's title and local instructions do not grant API permissions. Every future connected action must enforce its capability and scope on the server and record its actor.

Create a runtime credential from the company's Agents page and enter it when prompted; it is shown only once. From the company root, run:

```sh
mycompany agent login --server=https://YOUR-MYCOMPANIES-HOST
mycompany agent me
mycompany agent tasks
mycompany agent task 42
mycompany agent task status 42 in_progress
mycompany agent task create --title="Revisar informe" --idempotency-key=94030b4e-0580-42f6-96d6-cb2b2fe7b457
mycompany agent task assign 42 13
mycompany agent task edit 42 --priority=high --due-date=2026-12-01
mycompany agent bets
mycompany agent bet 42
mycompany agent bet evidence 42 --title="Entrevistas" --details="Cuatro de cinco personas describen el problema." --assessment=supports --source-url=https://example.com/research
mycompany agent bet status 42 investigating
mycompany agent bet convert 42 --type=product
mycompany agent offers
mycompany agent offer 42
mycompany agent offer status 42 available
mycompany agent forget
```

`agent me` fetches the current identity and grants from MyCompanies, so pausing the profile or revoking its credential takes effect on the next request. `agent tasks` lists only active tasks inside the grants currently accepted by the server; `agent task ID` shows one task's details as plain text. `agent bets` lists company bets and `agent bet ID` shows a bet's hypothesis and evidence; both are read-only and require `bets.read` or `bets.manage`. `agent bet evidence ID` requires `bets.manage`; it records one source observation and the Agent identity. Ratings (`supports`, `challenges`, `neutral`) describe how the evidence relates to the hypothesis and do not verify the hypothesis. `agent bet status ID STATUS` requires the separate `bets.status.manage` grant, records the actor in bet history, and cannot set `converted` or reopen a converted bet. `agent bet convert ID --type=product|service` requires the separate `offers.manage` grant and converts only a validated bet; the selected type is explicit, both histories record the Agent actor, and retries return the existing offer without duplicating it. `agent offers` lists offers and `agent offer ID` shows their details and source bet; they require `offers.read` or `offers.manage` and are read-only. `agent offer status ID STATUS` requires `offers.manage`; it changes only lifecycle status (`preparing`, `available`, `withdrawn`) and records the Agent actor. Repeating the current status does not add history. `agent task status ID STATUS` requests a status transition under `tasks.manage`; MyCompanies enforces dependency rules and records the Agent actor. `agent task create` also requires `tasks.manage` and an `Idempotency-Key` UUID. Reuse the same UUID when retrying the same request; the server returns the original task and rejects reuse with different fields. `agent task assign ID AGENT_ID|none` uses the separate `tasks.assign` grant; the recipient must be active and have `tasks.read` for the task's company or Workspace. `agent task edit` allows only title, description, priority, and due date under `tasks.manage`; it cannot change Workspace, status, or assignee. No task command executes scripts or interprets descriptions.

## Credential storage

Runner and Agent credentials are kept as separate JSON files under the user's private configuration directory. Agent credentials are selected by their associated company root and cannot be used as Runner credentials. The paths below show Runner storage; Agent files use the sibling `agents/` directory:

- Linux: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/.config/mycompanies/runners/`
- macOS: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/Library/Application Support/mycompanies/runners/`
- Windows: `%APPDATA%\mycompanies\runners\`

On Linux and macOS, the directory is restricted to mode `0700` and files to `0600`. On Windows files use the current user's AppData access controls. The CLI rejects symlinks for credential paths and will not overwrite an existing Runner enrollment. It can still read the earlier single-runner file `runner.json`.

## Scope and security

This release supports one-time enrollment, manual heartbeat, a fixed read-only workspace check, and read-only task listing/detail. It does not poll, access repositories, run scripts, or execute code received from the server. It opens no inbound ports. Runner credentials are revocable from MyCompanies; local workspace paths and tool secrets are not uploaded. HTTP redirects are not followed, response size is bounded, and error messages avoid returning response bodies or credentials.

The Agent CLI currently validates credentials, reads identity/grants, lists scoped active tasks, creates/edits tasks, changes task and offer status, assigns tasks to agents, reads company bets/evidence and offers, records bet evidence with `bets.manage`, changes bet status with `bets.status.manage`, converts validated bets with `offers.manage`, and publishes/lists/downloads company reports with the artifact grants. Launching an AI assistant is unavailable.

For report publication, an owner/admin must create an Agent profile, grant `artifacts.publish`, and issue that Agent a runtime credential from the company's Agents page. From the company root, run `mycompany agent login --server=https://YOUR-MYCOMPANIES-HOST` and enter the credential when prompted. Each Agent CLI credential is stored separately from Runner credentials and is selected by company root.

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
