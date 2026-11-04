# MyCompanies Runner CLI

`mycompanies-runner` is the standalone Node.js client for the MyCompanies Runner API. Its source has its own public GitHub repository so releases and npm publication are independent from the Laravel server.

- npm package: `mycompanies-runner`
- executable: `company-runner`
- Node.js: 20 or newer
- Runtime dependencies: none
- License: MIT

## Install

Once published to npm:

```sh
npm install --global mycompanies-runner
```

Until the npm package is published, install directly from GitHub:

```sh
npm install --global github:PabloTheBlink/company-runner
```

## Enroll and use

Create the workspace directory on the machine that will run the client. Then enroll it with the server:

```sh
company-runner enroll --server=https://YOUR-MYCOMPANIES-HOST --workspace-path=/path/to/workspace
```

Enter the one-time code from the MyCompanies Runners page when prompted. The prompt hides the code. The path is checked locally and is never sent to the server.

```sh
company-runner heartbeat
company-runner forget
```

The heartbeat displays the workspaces assigned to this Runner. Revoke the Runner from MyCompanies before using `forget` if the credential must stop working immediately; `forget` only deletes the local copy.

For local development only, HTTP is permitted for `localhost`, `127.0.0.1`, or `::1` with the explicit `--allow-insecure-localhost` option. Network hosts require HTTPS.

## Credential storage

The API token is stored as JSON under the user's configuration directory:

- Linux: `$XDG_CONFIG_HOME/mycompanies/runner.json`, or `~/.config/mycompanies/runner.json`
- macOS: `$XDG_CONFIG_HOME/mycompanies/runner.json`, or `~/Library/Application Support/mycompanies/runner.json`
- Windows: `%APPDATA%\mycompanies\runner.json`

On Linux and macOS, the directory is restricted to mode `0700` and the file to `0600`. On Windows the file uses the current user's AppData access controls. The CLI rejects symlinks for credential paths and does not overwrite an existing enrollment.

## Scope and security

This release supports one-time enrollment and manual heartbeat. It does not poll or claim tasks, access repositories, run scripts, or execute code received from the server. It opens no inbound ports. The token is revocable from MyCompanies; local workspace paths and local tool secrets are not uploaded. HTTP redirects are not followed, response size is bounded, and error messages avoid returning response bodies or credentials.

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
