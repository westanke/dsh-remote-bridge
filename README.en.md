# dsh-remote-bridge

<p align="center">
  <strong>Translates DSH's private remote protocol into a versioned REST API for mobile and third-party clients, plus a centralized settings center on the desktop.</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> · English
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v2.0.4-087f8c">
  <img alt="DSH plugin" src="https://img.shields.io/badge/DeepSeek_Harness-plugin-1f2328">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-586069">
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-2da44e">
</p>

`dsh-remote-bridge` is the remote-access bridge plugin for DeepSeek Harness (DSH). It translates DSH's private remote protocol into a versioned REST API so dsh-companion ([GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)) and other trusted clients can keep using the same chat, workspace, and file capabilities while away from the machine. On the desktop it provides a centralized settings center (Roots / Remote / Devices / Trash / Audit), and it ships a standalone file workspace page at `/dsh-workspace` for browsing and editing local files.

The interface is bilingual and defaults to Chinese. Prebuilt packages run on Windows, macOS, and Linux without compiling on the target server.

> **Version warning**: the published `v2.0.0` and `v2.0.1` have serious defects (`v2.0.0` fails to read any historical images; `v2.0.1` cannot activate the plugin). Use **`v2.0.4` or newer**.
> `v2.0.2` and `v2.0.3` were **never released** — do not look for installers under those version numbers.

> **DSH 0.2.x compatibility**: this branch adds a compatibility layer for DSH `0.2.0-rc.2` on top of
> upstream `v1.0.0`. DSH 0.2.x replaced `dsh-host-apiproxy` (which provided the `apiProxy` service)
> with `dsh-api-gateway`, leaving the upstream release unable to start on 0.2.x — it surfaces as
> "adding an authorized root returns 405". Background, rationale, changes, and test results are in
> [DSH 0.2.x compatibility notes](./docs/project/DSH-0.2-COMPAT.md).

## What it looks like

The desktop entry point is a settings-only panel: the sidebar button is now a **gear** icon and opens five settings sections. The directory tree, editor, and file operations were not removed — they moved out of the desktop panel into the plugin's standalone page `/dsh-workspace` (handy for a mobile WebView or a direct link).

Remote access remains disabled until a local administrator chooses a bind address, port, and initial device permissions.

> This section used to carry two UI screenshots, but both showed the pre-rename interface (titled "DSH 文件工作区"; the remote-access one was still labelled v1.0.0 and showed the file tree and settings as two stacked dialogs). They no longer match the shape described above, so they were removed rather than left to mislead. Re-recording needs a browser environment that can drive the plugin panel, which is not available here.

## About the rename (2.0.4)

The plugin was renamed from `dsh-workspace` to `dsh-remote-bridge`. The old name was narrower than the content: the plugin actually translates DSH's private remote protocol into versioned REST so a phone can reach this machine remotely, and adds a settings center on top — "workspace" is only one page of that.

**The rename only changes what you install and what the bundle is called. The following external contracts are deliberately unchanged:**

| Unchanged | Location | Why it must stay |
| --- | --- | --- |
| REST prefix `/dsh-workspace-api` | `src/host/server.ts` | Published apps hard-code it |
| Standalone page path `/dsh-workspace` | same | Mobile WebViews open that exact URL |
| Browser storage key `dsh-workspace-device-token` | `src/standalone/index.tsx` | Renaming it would invalidate the saved device token on the standalone page |
| State directory (`dataDir`, default `dsh-workspace`) | DSH profile config | A new directory would erase every authorized root and the trash |

So seeing `dsh-workspace` in a URL, the standalone page path, or the state directory is **expected**, not an incomplete rename.

## Quick install

### Requirements

- A working DeepSeek Harness WebUI installation
- DSH kernel `0.1.x` or `0.2.x` (0.2.x is supported by this branch's compatibility layer — see [DSH 0.2.x compatibility notes](./docs/project/DSH-0.2-COMPAT.md))
- Node.js `^22.19.0` or `>=24.0.0`
- Port `3090`, or another available port

Run as the same operating-system user that runs DSH WebUI (pick either host — the tarball is identical):

```sh
# GitHub
dsh plugin --profile web add https://github.com/westanke/dsh-remote-bridge/releases/download/v2.0.4/dsh-remote-bridge-2.0.4.tgz

# Gitee (faster from mainland China)
dsh plugin --profile web add https://gitee.com/westanke/dsh-remote-bridge/releases/download/v2.0.4/dsh-remote-bridge-2.0.4.tgz

npx @deepseek-ai/dsh web
```

> This README is shared verbatim by GitHub and Gitee, so any address that must carry a hostname
> (the install commands, release downloads) lists both hosts. Relative links follow the site you
> are reading on, but `/releases/download/...` has no relative form.

Restart WebUI after installation. A **Workspace settings** entry with a gear icon appears at the bottom of the sidebar; it opens the settings-only panel, which does **not** contain the file tree. The in-conversation **Files** tab was removed in 2.0.4. To browse or edit files, open the standalone page `/dsh-workspace`.

To install a downloaded release archive:

```sh
dsh plugin --profile web add ./dsh-remote-bridge-2.0.4.tgz
```

## First connection

1. Open **Workspace settings** from the gear icon in the DSH WebUI sidebar (it lands on **Roots**).
2. Add a local directory under **Roots** and give it a recognizable label.
3. To browse or edit files, open the standalone page `/dsh-workspace` and select that root.
4. For mobile access, go back to the settings panel and open **Remote**, enter the bind IP and port, and save them.
5. Select **Enable and create pairing**, then enter the ten-minute one-time code in the app.

Remote access cannot be enabled before at least one root exists. Installing the plugin does not expose it to the LAN; it listens on loopback until a local administrator enables remote access.

## Features

### File workspace (standalone page)

The file workspace now lives on the standalone page `/dsh-workspace`, reachable from a desktop browser, a mobile WebView, or a direct link:

- Lazy directory browsing and file/folder creation.
- Upload, download, replace, rename, and move.
- CodeMirror 6 editing for UTF-8 text.
- Best-effort preservation of UTF-8 BOM and original line endings.
- ETag conflict detection that refuses silent overwrites.
- Plugin-managed trash and restore; permanent purge stays local-only.
- Metadata, download, and replacement for binary files without treating them as text.

### Desktop settings panel

The sidebar button is now a gear icon labelled **Workspace settings**. The panel renders exactly five sections and lands on **Roots**:

| Section | Purpose |
| --- | --- |
| Roots | Add or remove authorized directories and set display labels |
| Remote | Set bind IP/port, enable remote access, and create pairing codes |
| Devices | Inspect and revoke device scopes and per-root grants |
| Trash | View and restore deleted entries |
| Audit | Operation type and target audit records |

The panel width shrank from 1400px to 920px, and the in-conversation **Files** tab was removed: the desktop keeps this single settings entry point.

### Stable client API

The public API is independent of DSH private wire protocols. Authorized clients can:

- list, register, rename, and remove DSH workspace registrations;
- create, rename, fork, and archive sessions;
- read history, stream text and reasoning, steer messages, and cancel runs;
- display TODOs, slash commands, permission modes, and approval requests;
- select Agents, models, and reasoning effort;
- inspect or update built-in and fully custom model providers;
- manage files and trash within explicitly granted roots.

## Remote access and security

The default remote target is `0.0.0.0:3090`; both values are configurable. Clients may connect through any reachable IP address or domain name.

HTTP is supported and TLS is not mandatory. That keeps trusted-LAN and temporary deployments simple, but plain HTTP sends device tokens, chat, and file content in clear text. Use HTTPS through Caddy/Nginx, a VPN, Tailscale/WireGuard, or a trusted tunnel on public or untrusted networks.

The following controls remain active over both HTTP and HTTPS:

- ten-minute, single-use pairing codes;
- 256-bit device tokens stored server-side only as digests;
- revocable scopes and per-root grants;
- separate rate limits for pairing, authentication failures, and normal requests;
- audit records that omit tokens, file bodies, and chat bodies;
- no automatic access to roots added after a device was paired.

Only a loopback client may add roots, change device grants, create pairing codes, configure the listener, or permanently purge trash.

## Path boundary

External requests use `rootId + relativePath`, never an absolute server path.

- Wire paths use `/`.
- Absolute paths, drive letters, UNC paths, backslashes, null bytes, and `.` or `..` segments are rejected.
- Every operation checks path segments for symlinks, junctions, and reparse points.
- Deleting a final link removes the link itself without traversing its target.
- Save temp files are placed beside the destination to avoid cross-device replacement failures.

Removing a DSH workspace removes only its WebUI registration. Directories, files, and session logs remain. Archiving a session hides it from the default list while preserving its log.

## Public API

REST base URL:

```text
http://HOST:PORT/api/v1
```

Every request except health and pairing exchange uses:

```http
Authorization: Bearer DEVICE_TOKEN
```

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Service, API, and plugin version |
| `POST /pairings/exchange` | Exchange a one-time code for a device token |
| `GET /devices/self` | Current device, scopes, and root grants |
| `GET /roots` | Granted file roots |
| `GET/POST/PATCH/DELETE /roots/{rootId}/entries` | List, create, move, rename, and trash entries |
| `GET/PUT /roots/{rootId}/content` | Read, Range download, upload, and ETag-safe save |
| `GET /trash`, `POST /trash/{id}/restore` | List and restore trash items |
| `GET/POST /chat/workspaces` | List or register DSH workspaces |
| `PATCH/DELETE /chat/workspaces/{id}` | Rename or remove workspace registrations |
| `GET/POST /chat/sessions` | List or create sessions |
| `PATCH /chat/sessions/{id}` | Rename a session |
| `POST /chat/sessions/{id}/fork` | Fork a session |
| `POST /chat/sessions/{id}/archive` | Archive a session |
| `GET/POST /chat/sessions/{id}/messages` | Read history, send, or steer messages |
| `GET/POST /chat/sessions/{id}/commands` | List or run host slash commands |
| `GET/POST /chat/sessions/{id}/approvals...` | View and decide approval requests |
| `GET /chat/sessions/{id}/models`, `PUT .../model` | Model catalog, selection, and reasoning effort |
| `PUT /chat/sessions/{id}/agent-preset` | Select an Agent before the first message |
| `POST /chat/runs/{id}/cancel` | Cancel a running session |
| `GET/POST/PATCH/DELETE /settings/...` | Providers, credential status, model discovery, and custom providers |
| `WS /events` | Chat deltas, runs, approvals, and file events |

See the [OpenAPI 3.1 contract](./docs/api/openapi.yaml), [AsyncAPI contract](./docs/api/asyncapi.yaml), and included [Kotlin SDK](./kotlin-sdk/README.md) for exact schemas.

Errors use one envelope:

```json
{"error":{"code":"ERROR_CODE","message":"Readable message","requestId":"..."}}
```

## Device scopes

| Scope | Access |
| --- | --- |
| `chat.read` | Workspaces, sessions, messages, TODOs, commands, and approvals |
| `chat.write` | Manage workspaces/sessions, send, configure, run commands, and decide approvals |
| `files.read` | Browse, read, download, and view trash |
| `files.write` | Create, edit, upload, move, and rename |
| `files.delete` | Move files or directories to plugin trash |
| `settings.read` | Effective provider configuration and credential presence |
| `settings.write` | Provider changes, credential writes, and custom providers |

A device also needs an explicit grant for every `rootId`. Local administrators may change or revoke both scopes and root grants at any time.

## Upgrade and uninstall

Stop DSH WebUI before upgrading, install the new package, then restart it. To uninstall:

```sh
dsh plugin --profile web remove dsh-remote-bridge
```

State is stored under `dsh-workspace` in the active `DSH_HOME`. Uninstalling does not erase state or trash, preventing accidental loss of recoverable files.

The 2.0.4 rename does not change that directory name: after upgrading, existing root grants and trash stay where they are. No migration is needed.

## Compatibility and known limits

### Some DSH builds have no attachment store

DSH's cordis injection properties (`ctx.attachments` / `ctx.fileUploads`) resolve lazily, and reading a service that nothing provides throws. Since 2.0.3 the plugin reads them tolerantly: when a service is absent the plugin still activates, and only the endpoint that actually needs it returns a readable error:

- `ATTACHMENT_STORE_UNAVAILABLE`: no `ctx.attachments`, so stored image bytes cannot be read.
- `FILE_UPLOADS_UNAVAILABLE`: no `ctx.fileUploads`, so attachments cannot be sent.

The user-visible consequence: **if this DSH build provides no attachment store, historical images in conversations cannot be displayed, but everything else in the plugin works normally** — and clients show the specific reason instead of a vague "image unavailable".

## Troubleshooting

**The file workspace entry is missing**

The sidebar entry is now the gear icon labelled **Workspace settings**; it opens the settings panel, which has no file tree. The file tree is on the standalone page `/dsh-workspace`. Make sure the plugin was installed into the `web` profile and restart DSH WebUI.

**Enable and create pairing is disabled**

Add at least one root. If the bind IP or port changed, save the listener settings first.

**The phone cannot connect**

Confirm remote access is enabled, the firewall/security group allows the port, and the address is reachable from the phone. Do not use the server's own `127.0.0.1` address.

**A save reports a conflict**

Another window or process changed the file. Reload it, merge the desired changes, and save again.

## Build from source

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

`pnpm check` covers type-checking, documentation consistency, and tests. It currently passes **17 test files / 104 cases**.

v2.0.4 was developed against DSH `master@47f943859bef60e4160492346772ded9b24f765a`. CI covers Windows, Ubuntu, and macOS.

## Project

- Version: `v2.0.4`
- Author: upstream [Hakunm](https://github.com/Hakunm); this fork maintained by [westanke](https://github.com/westanke)
- Repository: [GitHub](https://github.com/westanke/dsh-remote-bridge) · [Gitee](https://gitee.com/westanke/dsh-remote-bridge)
- License: [GNU Affero General Public License v3.0](./LICENSE)
- Android client: dsh-companion ([GitHub](https://github.com/westanke/dsh-companion) · [Gitee](https://gitee.com/westanke/dsh-companion)), a fork of the upstream [dsh-android-app](https://github.com/Hakunm/dsh-android-app), kept in step with this plugin
