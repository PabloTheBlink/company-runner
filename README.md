# MyCompanies Runner CLI

Independent npm CLI for connecting a company's computer to MyCompanies. It uses the server's authenticated Runner API and runs on Node.js 20 or newer. It has no runtime npm dependencies.

## Install

After the package is published:

```sh
npm install --global mycompanies-runner
```

For a local package archive:

```sh
npm install --global ./mycompanies-runner-0.1.0.tgz
```

## Enroll

Create a workspace directory on this computer, then run:

```sh
company-runner enroll --server=https://YOUR-MYCOMPANIES-HOST --workspace-path=/path/to/workspace
```

Paste the one-time code from the MyCompanies Runners page at the hidden prompt. The client stores the revocable API credential in the user's private configuration directory. It does not send the local workspace path to MyCompanies.

For local development only, HTTP to `127.0.0.1`, `::1`, or `localhost` requires the explicit option `--allow-insecure-localhost`.

## Commands

```sh
company-runner heartbeat
company-runner forget
```

The heartbeat reports the server-assigned workspaces. Revoke the Runner in MyCompanies before removing its local credential with `forget`.

This version supports enrollment and manual heartbeat only. It does not poll for work, access repositories, or execute scripts or code from the server. See the [protocol and security boundaries](https://github.com/PabloTheBlink/mycompanies/blob/main/docs/runner-protocol.md).
