# MyCompanies Runner CLI

`mycompanies-runner` is the standalone Node.js client for the MyCompanies Runner API. It has its own public GitHub repository so releases and npm publication are independent from the Laravel server.

- npm package: `mycompanies-runner`
- terminal command: `mycompany`
- Node.js: 20 or newer
- Runtime dependencies: none
- License: MIT

The CLI talks to MyCompanies through its HTTP API and has no direct database connection. Server database migrations, credentials, backups, and deployment belong to the Laravel repository; Runner needs only its API URL and its own revocable credential. This validation does not change the Runner protocol or local Runner configuration. The server's opt-in MariaDB HTTP checks cover the Runners page, heartbeat, a complete authorized workspace-check cycle (web authorization, claim, and result), Agent task-list and task-detail tenant isolation, and idempotent Agent task creation. Exact database/socket guards and transaction rollback are documented in the main repository's `docs/continuidad.md`; run them with `phpunit.mariadb.xml`. PHP test temporary-directory configuration belongs to the Laravel server; Runner's Node test workflow stays independent.

The MVP acceptance plan covers dependable business workflows and a usable responsive web interface for managing and tracking company work. The Laravel server UI now provides a company sidebar, a native collapsible mobile control, URL tabs for the company overview (summary, organization, business, work, and knowledge), and native create/edit dialogs for tasks, goals, and assets. Modal validation returns to the relevant list and reopens the selected form with its submitted values. Direct create/edit routes remain available as a fallback. These UI changes do not change the Runner API or release lifecycle. Dialogs for offers, bets, workspaces, and people/Agents, authorized Markdown observations, and a people/Agent organization chart remain server UI work. The organization chart is informational and does not grant permissions. Runner development during MVP closure should focus on defects or capabilities needed to verify the end-to-end flows. Optional CLI expansion and npm publication remain separate follow-up work. See the server repository's `docs/plan-de-cierre-mvp.md` for the current order and acceptance criteria.

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

`mycompany init` is a local-only, repeatable setup command. It creates `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code, and the fixed company-root layout: `agents/`, `architecture/`, `tasks/`, `automations/<id>/`, `reports/<id>/`, and `.mycompanies/`. Its managed instruction block documents the canonical `mycompany` CLI, the distinction between Agent and Runner reads, and how to prepare a company assessment from dated local notes and current read-only server state without treating either as permission to mutate data. It adds or refreshes only that clearly marked block, preserves text outside it, and never deletes existing files. It refuses symbolic-link targets and malformed managed blocks before writing anything. It makes no API calls and does not inspect environment files.

`mycompany agent credential list AGENT_ID [--after=ID]` requires `agents.credentials.manage` and lists credential metadata for a direct report, including revoked credentials and issuer/revoker type and name. It never returns or prints the secret or its stored hash. The CLI marks older credentials whose actor type predates attribution as `origen anterior`. The web Agents page shows the same issuer/revoker attribution to owners and admins. `mycompany agent credential issue AGENT_ID --name=NOMBRE` issues a credential only for an active direct report in the same company. The CLI stores the one-time secret in the user's private configuration directory and never prints it. `mycompany agent credential revoke AGENT_ID CREDENTIAL_ID` revokes only that credential. Other credentials and grants remain intact. The main Agent already associated with the company folder remains the default identity; choose another locally enrolled profile for a command or process with `MYCOMPANY_AGENT_ID=AGENT_ID`. All profiles can use the same company files, and the setting selects the authenticated identity only; the server still checks its live permissions for each operation.

Use `mycompany agent identities` to list local Agent profiles associated with the current company folder. It marks the default and the identity selected by `MYCOMPANY_AGENT_ID`, reads only the private local configuration, and never prints tokens or contacts the server.

The generated guidance keeps personal work, AI-assisted work with optional subagents, and recurring local scripts distinct. MyCompanies stores company-scoped agent profiles with stable identity, a flexible role label, initial instructions, and active/paused state. Owners/admins can record and revoke capability grants; changes are audited, and task grants can be limited to a Workspace. Each agent runtime can have a separately named, revocable Bearer credential; only its hash is stored and the secret is shown once. The versioned Agent API exposes the authenticated agent's identity and active grants, task list/detail, task creation, status changes and limited detail edits with `tasks.manage`, assignment with the separate `tasks.assign` grant, and read-only bet list/detail with `bets.read` or `bets.manage`, and evidence recording with `bets.manage`, plus bet status transitions with the separate `bets.status.manage` grant. An agent with `agents.permissions.manage` may grant only permissions it holds to active direct reports, at the same or narrower scope; grants retain their source. Agent API or owner/admin revocation cascades to active descendant grants, with each event attributed to the actor. Pausing an agent profile also revokes delegated descendants but preserves its own grants; reactivating it does not restore those descendant grants. Revoking one runtime credential does not affect other credentials for the same profile. Regranting a revoked permission does not restore descendants. Task reads accept `tasks.read` or `tasks.manage`; bet reads accept `bets.read` or `bets.manage`, while adding evidence requires `bets.manage` and status changes require `bets.status.manage`. Task creation starts tasks as open and unassigned, records the agent in status history, validates Workspace scope, and requires an `Idempotency-Key` UUID to make retries safe. A repeated key with the same payload returns the original task; a changed payload returns conflict. Status changes record their agent actor, honor task dependencies, and do not produce duplicate history when the requested status is already set. Detail edits are limited to title, description, priority, and due date; before/after differences are recorded and edits cannot change status, assignee, or Workspace. Assignment records the delegating agent; the assignee must be active and have `tasks.read` for the task's company or Workspace. `tasks.manage` does not imply `tasks.assign`, and reporting hierarchy or a CEO title gives no authorization. Paused agents, revoked credentials, and out-of-scope tasks are rejected. These credentials are separate from Runner credentials. The CLI can validate an Agent credential, query identity/grants, and list tasks within the active Agent grant scope; the CLI can create and assign tasks, request status transitions, edit task details, and read company bets and evidence and record bet evidence under `bets.manage` and change bet status under `bets.status.manage`. Agent APIs cannot edit profiles or execute local actions. Agents can record evidence on company bets with `bets.manage`; this stores an identity snapshot and an assessment as an observation without changing bet status or converting the bet into an offer. Other business grants do not yet have effective Agent API operations. The authenticated Agent can manually sync its own server-managed instructions with `mycompany sync`. The CLI writes only `agents/<agent-uuid>/instructions.md`, records the last synchronized hash in `.mycompanies/agent-profiles/<agent-uuid>.json`, and preserves local edits by reporting conflicts. Running it from a nested project still writes under the linked company root. It does not sync other profiles, skills, general company files, credentials, or secrets; it never deletes files or runs automatically. `mycompany update` updates the CLI package separately.

Task authorization is evaluated by the server for each request using the Agent's current credential, grants, company, and Workspace scope. The CLI's selected identity and local folder help choose a credential; they do not grant server access. Assignment is separately authorized by `tasks.assign`, and the receiving Agent must hold `tasks.read` for the assigned task.

MyCompanies will own company/workspace data, human and agent identities, permissions, tasks, bets, offers, and schedules. The company root remains the source for repositories, scripts, secrets, and skill contents. A logical Workspace may be linked to a local folder or repo explicitly, but it is never assumed to be one physical directory.

Enter the one-time code from the MyCompanies Runners page when prompted. The prompt hides the code. The current folder is checked locally and is never sent to the server. For local development only, HTTP is allowed for `localhost`, `127.0.0.1`, or `::1` with `--allow-insecure-localhost`; network hosts require HTTPS. Use `mycompany help` for a Spanish description of each command, its local or server effects, and its current limits.

Owners and admins can revoke a Runner from its company page. Revocation disables its enrollment code and credential, closes still-authorized executions, and expires their leased attempts. Workspace changes are company-scoped and are rejected for revoked Runners. Invitation links are likewise bound to one company; only a matching authenticated account can accept them, and an owner cannot revoke another company's invitation. Regression tests cover cross-company invitation revocation and Runner workspace assignment.

On the web server, sensitive bet actions also recheck current company membership while holding the company lock in the write transaction. Evidence recording and converting a validated bet into an offer stop if the actor lost owner/admin access while the request was in flight; the bet is loaded through that company before writing.

Human web task changes are also company-scoped: task writes recheck owner/admin access in a transaction, assignments must target a company member or an active Agent with task access, and dependencies must stay within the company and cannot form a cycle. Runner task listing/detail remain read-only and are separately limited to the Runner's current Workspace assignments.

Agent hierarchy and permissions are a separate server API from Runner credentials. Agent management writes revalidate the active Agent credential and the permission required for the operation in a company-locked transaction. Delegation requires an active source grant at an equal or broader scope, and revoking it also revokes delegated descendants. Issued credential secrets are shown once; history endpoints expose metadata only and disable caching.

Company memory is a separate, company-scoped knowledge system with provenance, typed relationships, learning history, reviewable syntheses, and replaceable embeddings. Its first server slice now supports topic-scoped read/write grants, attributed entries, and creation events. Runner remains an execution client; memory access belongs to the authenticated Agent identity and explicit company, Workspace, and topic grants. A CEO title or semantic similarity does not grant access or establish truth. The server API owns authorization; local commands never bypass it.

The CLI provides `mycompany agent memory topics`, `list`, `search`, `show`, and `add`. Reads require a `memory.read` grant; writes require a topic and `memory.write`. `search --query=TEXT` optionally accepts `--topic=ID` and `--workspace=ID`. Without filters, the server searches only the nodes covered by the Agent's grants; with filters, it narrows the search further. The server filters nodes by company and grants before comparing vectors, then returns up to 20 results ordered by cosine relevance. The company web page also offers semantic search for signed-in members, limited to that company, and a «Solo propuestas pendientes» filter for entries linked to suggestions awaiting review. The web review form preserves active search/filter values when it redirects after an accepted or dismissed relation. Members can create a manual synthesis from the web page by linking same-company source entries; the CLI and Agent API do not create syntheses. Relevance is not confidence or verification. Entries may be attributed to a person, Agent, importer, or other system process; the CLI preserves that attribution. `show` also prints the server's reviewable relation suggestions when both nodes are visible to the Agent. Owner/admin members can accept or dismiss suggestions on the company memory page; reviews are attributed to the user and never merge or delete entries. Treat entries as attributed observations, hypotheses, decisions, or claims: the CLI displays what the server recorded and does not verify its truth. A suggested relation is a lead for review, not an instruction or proof. `mycompany agent runtime run TASK_ID --provider=codex|agy --include-memory` explicitly requests read-only memory context for a task; the CLI searches using its title and description, includes at most five authorized entries, and requires a separate typed confirmation before sending them to the local model. The Agent credential never enters the model prompt. This is preloaded context, not an on-demand model tool. Large-volume indexing, revisions, and automatic synthesis are not available from the CLI. See the server repository's `docs/memory-architecture.md` for the access model and roadmap.

Memory imports should preserve source, date, author, scope, and uncertainty. Import durable decisions, outcomes, and reusable learnings rather than bulk activity logs or agent cycles. Keep time-series metrics in structured records and reports/files as artifacts; memory can retain their interpretation and a reference. Never promote generated or unverified source material to observed evidence. Company-specific migration scripts belong with that company's data work, not in this generic CLI repository.

## Real Codex trial status

On 2026-11-04, Codex CLI 0.157.0 was launched directly with `codex exec` in Devetty's new `reports/apify-eu-ted/` folder and wrote a market audit for MyCompanies task #7. The task and its public Store research were selected and prepared manually. Marta's local `instructions.md` was used only as prompt context: the marketing agent Marta was **not** executed, authenticated, or recorded as the author. Later, the Runner's Codex adapter was verified with a real isolated `CODEX_RUNTIME_OK` run and a canary check that confirmed a file outside staging was blocked. On 2026-11-05, task #136 was created for a read-only real runtime trial and assigned to Vera. It ran through the Agent identity with `--include-memory`, supplied five authorized memory entries to Codex, and returned a sourced summary. The task remains open as requested in its own instructions; no company files or external systems were changed. Marta still needs her own owner/admin setup before she can run tasks.

A second run of task #136 exercised the runtime's custom memory query and topic filter: `--memory-query="systemctl approval sandbox assigned Iker" --memory-topic=7`. The server returned five memories scoped to Vera's existing `memory.read` access in «Agentes y coordinación»; the prompt included those entries but no Agent token. Codex cited the relevant historical decision #143 and #59, distinguished the records from current authorization, called out less relevant memories, and did not treat a legacy `--dangerously-skip-permissions` reference as permission. The task remains open, and no files, tasks, grants, or external systems were changed. The run used network-disabled Codex and the required typed confirmation.


The first upload attempts as `.md` and `.txt` returned HTTP 422 because PHP could not write multipart uploads to `/tmp`: that directory had exhausted the user's quota. MyCompanies was restarted with a private upload temporary directory configured via `PHP_INI_SCAN_DIR`; the exact host setup is recorded in the MyCompanies continuity log. Retrying `mycompany artifact publish` succeeded and created artifact #1, confirmed by `mycompany artifacts`. The temporary local `read` grant was revoked after publication. Task #7 remains open because the publishing identity has no task-management grant and Codex was not run through a MyCompanies task runtime. See the Devetty report and MyCompanies continuity log for the full trial record.

The CLI provides `mycompany agent runtime run TASK_ID --provider=codex|claude|agy` for manually confirmed task execution. Codex uses `codex exec --approve-for-me`, which selects Codex's `workspace-write` sandbox; network stays disabled unless a separate `--allow-network` confirmation is given. Before launch, the CLI requires a typed confirmation and supplies only authorized read files plus the exact paths granted for writing. A new write-only file is left absent in staging so the provider can create it; the CLI applies only those granted paths and can publish one selected artifact with `--publish`. AgY applies its own sandbox. Claude Code is launched with its restricted mode, only `Read`, `Write`, and `Edit`, no shell, web, or MCP tools, and the private staging directory as its working directory. The adapter is covered by simulated process tests, but a real provider run has not been made yet; it is scheduled for 2026-11-06 when provider tokens are available. No automatic polling, scheduling, task completion, or central execution history is created by this runtime. The earlier Devetty report remains a manual Codex run, not an execution by Marta. The host's private PHP upload temporary directory must remain available when starting the local Laravel server; otherwise uploads can fail when `/tmp` reaches the user's quota.

For a memory-enabled run, `--include-memory` defaults to a search made from the task title and description. Use `--memory-query="TEXT"` to replace that search text, `--memory-topic=ID` to narrow it to a topic, and `--memory-workspace=ID` to narrow it to a workspace. These options require `--include-memory`; filters can only reduce results because the server applies the Agent's current company grants. The runtime still sends at most five results after the existing typed confirmation. For example: `mycompany agent runtime run 136 --provider=codex --include-memory --memory-query="systemctl approval sandbox" --memory-topic=7`. The query is sent to MyCompanies' memory search API and is not itself inserted in the model prompt.

`--include-company-context` is a separate opt-in. Before starting the provider, the CLI uses the Agent credential to read tasks, goals, Workspaces, assets, bets, offers, and artifacts where the identity has a matching read or management grant. MyCompanies applies company and Workspace scope on each request. The confirmation lists the sections that will be sent; the credential stays in the CLI. The context includes at most ten summaries per section, marks sections the Agent cannot access separately from empty lists, and stops before model launch if the serialized context exceeds 64 KiB. This is a point-in-time snapshot from the server, not an on-demand tool for the model. Memory remains separate and is included only with `--include-memory`.

Later, run commands from that company root or any folder inside it:

```sh
mycompany heartbeat
mycompany work
mycompany execute
mycompany tasks
mycompany task 42
mycompany forget
```

With several enrolled folders, the CLI selects the credential whose company root contains the current directory. If company roots are nested, the most specific match wins. The heartbeat confirms the selected company and Runner by name. If no folder matches, the command stops without contacting the server. `forget` removes only the credential selected for the current folder; revoke it from MyCompanies first to invalidate it immediately.

`mycompany work` makes one request for an explicitly authorized read-only workspace check. It does not poll continuously, run shell commands, execute scripts, or send local paths. Unknown capabilities are rejected. The result endpoint rechecks Runner revocation inside the same transaction that records the result, so a credential revoked after request authentication cannot submit a check result.

`mycompany execute` makes one request for an explicitly authorized `devto.stats.totals@1.0.0` execution. It first checks that the fixed adapter is installed, then claims the authorization and waits for the server to confirm `/start` before running the local Python script. It submits only article IDs and numeric metrics (or a fixed failure code). It does not execute server-provided commands, poll, schedule work, or include local paths, logs, or secrets in the result. Each authorization permits at most one started attempt. A lease that expires before `/start` may be replaced; after any start, success, failure, or uncertainty consumes the authorization. An owner/admin must create a new authorization for another run. No attempt is repeated automatically after a timeout or network failure; the server may mark it `uncertain` for human review. Owners and admins can review attempt status and filtered results on the Runner execution authorization page.

`mycompany tasks` lists up to 100 active tasks from every workspace currently assigned to the selected Runner. It shows each task's title, status, priority, due date, workspace, and responsible person's or agent profile's name. This is the current assignment only; the CLI does not read assignment history. The identity is informational; the Runner does not become that agent or gain its permissions. The list does not download descriptions or execute tasks. Tasks in unassigned workspaces, tasks without a workspace, and completed or cancelled tasks are excluded. Both list and detail APIs filter by the Runner's company and current workspace assignments; cross-company and unassigned-workspace task details return not found. If an assigned human member is removed from the company, MyCompanies clears their task assignments and records the former assignee and removing user in assignment history. The task remains open in its Workspace, so a Runner assigned there may still list it with no responsible person. Use `--status=open`, `--status=in_progress`, or `--status=blocked` to filter the active set; for example `mycompany tasks --status=blocked`. On the web, company members can also filter the task list by Workspace and responsible human or Agent; this changes only the web listing and does not change Runner scope. If there are more results, continue with the `--after` ID shown by the CLI, preserving the status filter when one is selected.

When no responsible identity is assigned, the CLI prints `responsable sin asignar`.

`mycompany task ID` shows the description, responsible identity, and details for one active task, if its workspace is currently assigned to the selected Runner. The endpoint returns `404` for tasks outside that scope, completed tasks, and unknown IDs. The command prints the text for a person to review; it does not interpret or execute it.

## Publish and retrieve company reports

An Agent with `artifacts.publish` can publish one explicitly selected report from the company folder. The server stores a private copy; the source file remains local:

```sh
mycompany artifact publish reports/daily.md --title="Informe diario" --source="daily-report"
mycompany artifacts
mycompany artifact show 42
mycompany artifact download 42 --output=reports/shared-copy.md
```

The Dev.to analytics script in the Devetty example keeps its default local-only behavior. To generate and share its report in one explicit action, run `python3 automations/devto/devto_stats.py report --publish` from the company root. The script first saves the report locally, then invokes the CLI with that exact report path. It requires an active Agent CLI credential with `artifacts.publish`.

The CLI does not schedule commands. No daily run is configured for Devetty. If one is added later, use a local scheduler with the company root as its working directory, an explicit timezone, and a `PATH` that includes both Python and `mycompany`; keep secrets outside the schedule text. Runner does not execute this script.

Only `.md`, `.txt`, and `.pdf` files up to 10 MiB are accepted. The CLI rejects symlinks and paths outside the selected company root. `artifact show` displays the title, source, publisher, date, checksum, and other metadata without downloading the content. Downloads must target a new path under that root and are created with owner-only file permissions on Unix. `artifacts.read` allows listing and downloading; `artifacts.publish` also includes read access. Human company members can browse and download the same reports in the web app. The feature publishes individual files; it does not sync folders, run schedules, or execute scripts.

## Local AI providers in a company folder

You can start Codex, Claude Code, or Antigravity CLI (`agy`) manually from a company root after reviewing that company's `AGENTS.md` or `CLAUDE.md`. The CLI can separately authenticate as a MyCompanies Agent and show its server identity and active grants. `agent runtime` detects these three executables, and `agent runtime plan` confirms access to a specific active task and checks that it is assigned to the selected Agent; neither command launches an assistant or executes the task. A profile's title and local instructions do not grant API permissions. Every connected action must enforce its capability and scope on the server and record its actor.

Create a runtime credential from the company's Agents page and enter it when prompted; it is shown only once. From the company root, run:

```sh
mycompany agent login --server=https://YOUR-MYCOMPANIES-HOST
mycompany sync
mycompany agent me
mycompany agent runtime plan 42 --provider=codex
mycompany agent runtime plan 42 --provider=agy
mycompany agent tasks
mycompany agent tasks --status=blocked
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
mycompany agent goals
mycompany agent goal 42
mycompany agent assets
mycompany agent asset 42
mycompany agent workspaces
mycompany agent workspace 42
mycompany agent agents
mycompany agent create --name="Directora marketing" --role=Marketing --instructions="Analiza canales y comparte evidencias."
mycompany agent permissions
mycompany agent pause 26
mycompany agent resume 26
mycompany agent edit 26 --role="Marketing lead" --instructions="Prioriza datos verificables."
mycompany agent edit 26 --instructions=none
mycompany agent permission grant 26 tasks.read --workspace-id=8
mycompany agent permission revoke 26 91
mycompany agent forget
```

`agent me` fetches the current identity and grants from MyCompanies, so pausing the profile or revoking its credential takes effect on the next request. `agent tasks` lists only active tasks inside the grants currently accepted by the server; it requires `tasks.read` or `tasks.manage`, otherwise the API returns `403`. Add `--status=open|in_progress|blocked` to filter that set, and `--after=ID` to continue a page while preserving the filter. The API still applies the Agent's company or Workspace scope. `agent task ID` shows one task's details as plain text. `agent agents` lists only direct reports, their status and active grants; it requires `agents.permissions.manage` and does not expose instructions or credentials. `agent create` creates a direct report under `agents.manage`, active with no permissions or credential. An owner/admin must issue its runtime credential from the web interface; an authorized Agent may then delegate permissions it holds. `agent permission grant AGENT_ID PERMISSION [--workspace-id=ID]` delegates only a permission the caller holds to an active direct report, at the same or narrower scope. `agent permission revoke AGENT_ID GRANT_ID` revokes that grant and any descendants derived from it; MyCompanies records the actor. Both require `agents.permissions.manage`; permission ownership and company boundaries are checked server-side. `agent goals` lists company objectives and `agent goal ID` shows the description, success criteria, status, and target date; both are read-only and require `goals.read` or `goals.manage`. `agent assets` lists company assets and `agent asset ID` shows their details; both are read-only and require `assets.read` or `assets.manage`. `agent workspaces` lists company Workspaces and `agent workspace ID` shows their stable UUID and logical metadata; both are read-only and require `workspaces.read` or `workspaces.manage`. This does not expose or create a local folder. `agent bets` lists company bets and `agent bet ID` shows a bet's hypothesis and evidence; both are read-only and require `bets.read` or `bets.manage`. `agent bet evidence ID` requires `bets.manage`; it records one source observation and the Agent identity. Ratings (`supports`, `challenges`, `neutral`) describe how the evidence relates to the hypothesis and do not verify the hypothesis. `agent bet status ID STATUS` requires the separate `bets.status.manage` grant, records the actor in bet history, and cannot set `converted` or reopen a converted bet. `agent bet convert ID --type=product|service` requires the separate `offers.manage` grant and converts only a validated bet; the selected type is explicit, both histories record the Agent actor, and retries return the existing offer without duplicating it. `agent offers` lists offers and `agent offer ID` shows their details and source bet; they require `offers.read` or `offers.manage` and are read-only. `agent offer status ID STATUS` requires `offers.manage`; it changes only lifecycle status (`preparing`, `available`, `withdrawn`) and records the Agent actor. Repeating the current status does not add history. `agent task status ID STATUS` requests a status transition under `tasks.manage`; MyCompanies enforces dependency rules and records the Agent actor. `agent task create` also requires `tasks.manage` and an `Idempotency-Key` UUID. Reuse the same UUID when retrying the same request; the server returns the original task and rejects reuse with different fields. `agent task assign ID AGENT_ID|none` uses the separate `tasks.assign` grant; the recipient must be active and have `tasks.read` for the task's company or Workspace. `agent task edit` allows only title, description, priority, and due date under `tasks.manage`; it cannot change Workspace, status, or assignee. No task command executes scripts or interprets descriptions.

`agent permissions` retrieves the current permission catalogue from the authenticated server, including human-readable labels and whether each capability supports Workspace scope. It is read-only and does not show which grants this Agent currently holds; use `agent me` for that.
`agent pause AGENT_ID` and `agent resume AGENT_ID` require `agents.manage` and affect only an active direct report in the same company. Pausing revokes permissions delegated by that report to lower levels, records the acting Agent, and leaves the report's own grants intact. Resuming does not restore revoked descendant grants. Repeating the current state is harmless and does not create another history entry.
`agent edit AGENT_ID [--role=ROL] [--instructions=TEXTO]` also requires `agents.manage` and changes only those two profile fields on a direct report. Use `none` to clear a field. It cannot change name, hierarchy, status, permissions, or credentials. The API response omits instructions; the audit history records changed field names and actor, not prompt contents. Repeating the same values creates no duplicate history.

`agent credential issue AGENT_ID --name=NOMBRE` requires the separate `agents.credentials.manage` permission and creates a runtime credential only for an active direct report. It stores the secret in the CLI's private per-user configuration and never writes it to terminal output or company files. `agent credential revoke AGENT_ID CREDENTIAL_ID` invalidates only the selected credential. Issuance and revocation record the acting Agent. To let a child Agent operate from the same company directory, set `MYCOMPANY_AGENT_ID` to that child's ID for its process; without it, the original/default Agent is selected. This does not grant the child any business permissions or launch an AI runtime.

### Local Agent file grants

`mycompany agent runtime files list` shows local file grants for the Agent identity selected in this company folder. Use `grant PATH --operation=read|write` or `revoke PATH --operation=read|write` to change one exact relative path. Each change requires entering the displayed confirmation phrase in an interactive terminal. `read` means the Agent may see the file contents; `write` permits changes. The policy and append-only change history are stored in the user's private configuration, separate from company files and server grants. Symlinks, absolute paths, traversal and terminal control characters are rejected.

These commands record local policy; controlled Codex, Claude Code, and Antigravity task runs apply them through the staging mediator. The grants do not authorize server API actions or network access. Claude Code receives only staged files and has no shell, web, or MCP tools in this adapter. Its real provider run remains pending; simulated tests do not establish provider authentication or successful execution.

### Run one assigned task with Antigravity CLI

On Linux, a company owner/admin must grant the Agent `tasks.read` and assign an active task to it before this command can run:

```sh
mycompany agent runtime run 42 --provider=agy --timeout=300
```

The command fetches the active Agent identity and task, then asks for an exact interactive confirmation. The confirmation names the task and lists every `read` and `write` file path. The task description and files with `read` permission are sent to Antigravity's model service. MyCompanies does not receive the prompt or local file contents.

The CLI stages only granted paths in a private temporary directory under the user's private MyCompanies config directory. It invokes `agy` without a shell, forces the terminal sandbox, disables non-workspace file access, and denies shell commands, unsandboxed commands, web actions, and MCP tools for that session. The task description is passed over stdin rather than exposed as process arguments. If the host sandbox cannot be verified, the provider is not started. On success, the CLI rechecks write grants and original file hashes, then applies only staged changes to exact `write` paths; extra files are discarded. Timeout, interruption, provider error, or invalid output applies no changes. The staging directory is removed after the run.

Before applying staged changes, the CLI fetches the task again. It must still be active and assigned to the same Agent, and its title, description, priority, due date, and Workspace must match the values sent to the provider. If the assignment or task context changed, the CLI discards the staging directory and skips local writes and publication.

Without `--publish`, the result is printed in the terminal; this local run does not change task status, create a server-side Execution record, or publish a report. Codex supports `--provider=codex` with the same task and file checks; it uses an ephemeral session and workspace-write sandbox. Network access is disabled by default. For public research, `--allow-network` enables unrestricted outbound network for that single Codex run and adds `CON_RED` to the exact confirmation phrase; it is not domain-filtered. Do not use it with sensitive local files. AgY keeps web, URL, and MCP tools denied. Claude Code uses its restricted CLI mode with only staged file tools, without shell, web, or MCP. Its adapter has simulated test coverage; a real run remains pending provider availability. The AgY implementation uses Antigravity's documented [headless mode](https://antigravity.google/docs/cli/headless/), [sandbox](https://antigravity.google/docs/cli/sandbox), and [permission rules](https://antigravity.google/docs/cli/permissions); see `mycompany help` for the current CLI surface.

To publish one generated report, pass its exact relative path:

```sh
mycompany agent runtime run 42 --provider=agy --publish=reports/daily.md
```

The selected Agent must have the server permission `artifacts.publish`, and the same exact path must have a local `write` grant. The file must be `.md`, `.txt`, or `.pdf`; the CLI includes it in the written confirmation and publishes it only after the local write checks succeed. Publication uses the existing authenticated artifact API. If upload fails, local authorized changes remain in the company folder and the CLI reports the upload error.

## Credential storage

Runner and Agent credentials are kept as separate JSON files under the user's private configuration directory. Agent credentials are selected by their associated company root and cannot be used as Runner credentials. The paths below show Runner storage; Agent files use the sibling `agents/` directory:

The web UI displays a newly issued Agent credential only once and only on the Agents page for the company that issued it. After copying it, enroll it from that company's local folder; the CLI keeps its private credential associated with that folder.

- Linux: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/.config/mycompanies/runners/`
- macOS: `$XDG_CONFIG_HOME/mycompanies/runners/`, or `~/Library/Application Support/mycompanies/runners/`
- Windows: `%APPDATA%\mycompanies\runners\`

On Linux and macOS, the directory is restricted to mode `0700` and files to `0600`. On Windows files use the current user's AppData access controls. The CLI rejects symlinks for credential paths and will not overwrite an existing Runner enrollment. It can still read the earlier single-runner file `runner.json`.

## Scope and security

This release supports one-time enrollment, manual heartbeat, a fixed read-only workspace check, read-only task listing/detail, and one manually authorized read-only Dev.to stats capability. It does not poll, access repositories, or execute code received from the server. It opens no inbound ports. Runner credentials are revocable from MyCompanies; local workspace paths and tool secrets are not uploaded. HTTP redirects are not followed, response size is bounded, and error messages avoid returning response bodies or credentials.

### Limited manual execution contract

MyCompanies now lets an owner/admin record or revoke an explicit `ExecutionRequest` for an active task, one assigned Workspace and Runner, and the fixed capability `devto.stats.totals@1.0.0`. Revoking a Runner also revokes its still-authorized requests and expires their unstarted leases; the owner/admin can still inspect the authorization history afterward. Repeating the same idempotency key and payload returns the same request; changed content conflicts. The CLI command `mycompany execute` claims only this installed capability, calls `/start` before the adapter, enforces the server's runtime deadline locally, and sends the filtered result to `/result`. One `ExecutionRequest` authorizes one started attempt; a lease expiring before `/start` may be replaced, but a later run requires a new owner/admin authorization. It never automatically restarts a timed-out or uncertain run. The server never sends shell commands, file paths, scripts, code, or secrets.

The first local business capability is `devto.stats.totals`. Its adapter invokes only the fixed local operation `python3 automations/devto/devto_stats.py stats totals`, requires Python 3 and that file inside the company folder, filters output to article IDs and numeric metrics, and enforces a 1 MiB output cap and at most 120-second timeout. It does not create reports, invoke a model, write files, or publish content. The API key remains local to the script and is never included in the request or returned result. The existing `report`, `post`, and `content` operations are excluded because they can invoke a model, write files, or publish publicly. Tests stub the process runner and do not call Dev.to. See the server's `docs/runner-protocol.md` for the full contract.

The web authorization history derives an overdue `running` attempt as `uncertain` for display once its runtime deadline passes. Loading that page does not update the stored attempt; it asks an owner/admin to review before creating a new authorization. The CLI does not retry uncertain attempts.

Run `mycompany capabilities` from an enrolled company folder to check which supported local adapters are present. It only checks local files, does not contact MyCompanies or Dev.to, does not inspect `.env` or print credentials, and does not run an adapter.

The Agent CLI currently validates credentials, reads identity/grants, creates and manages direct report profiles with `agents.manage`, delegates/revokes grants with `agents.permissions.manage`, and issues/revokes individual report credentials with `agents.credentials.manage`. It also lists scoped active tasks, company goals, assets and Workspaces; creates/edits tasks; changes task and offer status; assigns tasks to agents; reads company bets/evidence and offers; records bet evidence with `bets.manage`; changes bet status with `bets.status.manage`; converts validated bets with `offers.manage`; and publishes/lists/downloads company reports with artifact grants. `mycompany agent runtime` detects Codex, Claude Code and Antigravity CLI (`agy`) in `PATH`. `mycompany agent runtime plan TASK_ID --provider=codex|claude|agy` confirms the active Agent identity, API read access to the task and that its assignee ID matches the Agent. The plan prints only the task title and status; it does not launch a provider, run local scripts or start execution.

The CLI has manually started Codex, Claude Code, and AgY runtime adapters. MyCompanies grants govern API operations; they do not grant local shell, filesystem or network permissions. The server will not deliver executable commands. Local file access is granted separately by a person, per Agent, operation and path; an explicit grant may include reading or editing `.env`. Such a grant exposes its values to that Agent. Codex runs in a bounded `workspace-write` sandbox with network disabled; AgY uses its own sandbox and denied-tool policy. Claude Code uses `--restricted`, with only `Read`, `Write`, and `Edit` in the staging directory and without shell, web, or MCP tools. The Claude adapter has simulated process coverage, but has not yet been verified with a real provider run. Reporting hierarchy and role labels never grant local access. Running in a company root alone is not a sufficient boundary for path-specific permissions. See [MyCompanies architecture](https://github.com/PabloTheBlink/mycompanies/blob/main/docs/vision-and-architecture.md#dirección-para-conectar-un-runtime-local).

`src/runtime.js` contains a tested exact-path policy matcher for `read` and `write`, keyed by Agent ID. `src/local-agent-files.js` stages only granted files outside the company root, gives write-only grants an empty file, and applies back only paths still authorized for writing. It rejects symlinks and unsafe roots, requires a private staging directory on POSIX, and checks the original file hash before replacing it. The CLI stores local grants privately and connects this mediator to interruptible Codex, Claude Code, and AgY processes. `agent runtime plan` remains a preflight only; it does not launch a provider. Claude Code's real provider run remains pending.

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

Keep `bin.mycompany` as `src/cli.js` without a leading `./`. npm 11 removes that executable during publish normalization when the path has the prefix; `test/package.test.js` guards the published manifest.
