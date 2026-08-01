# LangLangBot channel

Connect OpenClaw to **LangLangBot** so the **LangLang Operator app** (mobile client) can chat with your Agent and approve sensitive exec/plugin actions.

LangLangBot is platform-agnostic: the Operator app may be iOS, Android, or another client that speaks the same gateway API.

## Setup

1. **Install** sidecar + OpenClaw plugin on the Agent host (Linux x64/arm64 or macOS arm64):

```bash
curl -fsSL https://optimatist.ai/langlangbot/install.sh | bash
```

2. **Pair** with iOS Operator (shown in the app after Agent surface creation):

```bash
langlangbot pair --id <agent_surface_id>
```

Confirm the 6-character code and TLS fingerprint in the Operator app when prompted.

3. Configure OpenClaw — **LangLangBot starts automatically** when the gateway enables this channel (`autoStartSidecar: true` by default):

```json5
{
  channels: {
    langlangbot: {
      enabled: true,
      sidecarUrl: "https://127.0.0.1:9528",
      autoStartSidecar: true,
      pluginToken: "<optional shared secret>",
      sidecarBinary: "/path/to/langlangbot",
      sidecarEnvPath: "~/.langlangbot/env",
      streaming: true,
    },
  },
  approvals: {
    exec: { enabled: true, mode: "session" },
    plugin: { enabled: true, mode: "session" },
  },
}
```

3. Operator app: conversation SSE for chat; approvals via `GET /v1/approvals/events` (session token), then `POST /v1/approvals/{id}/decide` (`allow-once` / `allow-always` / `deny`). OpenClaw plugin bridge listens on `GET /v1/approvals/plugin/events` (plugin token) for `approval_decided`.

Additional approval sources (for example enterprise gateway intents) use the same LangLangBot approval inbox with extensible `kind` strings — no extra OpenClaw channel required.

## Operator connection path

When the user asks how they are connected to LangLangBot (LAN vs dedicated network), call **`langlangbot_connection_current`** before answering. Do not guess from generic networking knowledge or suggest ping/nslookup on the Agent host.

The tool reads the Operator app's observed ingress path for the active conversation. Answer with the returned `transport` value (`LAN` or `dedicated network`). Use `remote_addr` for the Operator device and `matched_endpoint` for the LangLangBot listen address on that path.

## Operator runtime context

<!-- FIXME(openclaw-upstream): Remove this section once OpenClaw session_status uses the correct
     context window and token stats (openclaw/openclaw#92760, openclaw/openclaw#70692). -->

When the Operator asks about context usage, context window size, current model, or any stat shown in the LangLang app runtime bar:

1. Call **`langlangbot_operator_runtime_status`** first.
2. Report model, tokens, window, and percent **only** from that tool.
3. Do **not** cite the built-in `session_status` tool's `Context: …/200k (…%)` line for Operator-facing answers.
4. If the tool is unavailable, say runtime status is temporarily unavailable — do not invent 200k/24k figures.

OpenClaw's `session_status` may show a 200k fallback denominator and different token totals; this plugin tool reads the same session-store projection as the Operator app bar (`GET /v1/conversations/{id}/agent/status`).

## Operator reminders (cron)

LangLangBot supports two scheduling paths. Pick whichever matches the agent's available tools.

### Prerequisite: `cron` tool visibility (owner-only)

OpenClaw registers a built-in **`cron` tool** (included in `tools.profile: "coding"`). It is **owner-only**: non-owner chat senders do not receive it in the tool list.

When the Operator opens a conversation via ODA (`session.open`), LangLangBot records the verified owner surface on that conversation. Each inbound user message includes `owner_surface_id` on the plugin SSE; the LangLangBot OpenClaw plugin sets **`OwnerAllowFrom`** for that turn from the attested surface. You usually **do not** need `commands.ownerAllowFrom` in `openclaw.json` for Operator chat.

Your Operator sender id is the inbound `From` value, typically:

`owner:<owner-surface-id>`

Example from an active session: `owner:PJJkkprTmv/lGeX8qq9AJQCmrs2lqBi1C3V5ODFIWqM=`

**Fallback** — pin a human operator manually when the sidecar cannot attest a surface (dev without ODA, or legacy config):

```json5
{
  commands: {
    ownerAllowFrom: [
      "langlangbot:owner:PJJkkprTmv/lGeX8qq9AJQCmrs2lqBi1C3V5ODFIWqM=",
    ],
  },
}
```

Or:

```bash
openclaw config set commands.ownerAllowFrom '["langlangbot:owner:PJJkkprTmv/lGeX8qq9AJQCmrs2lqBi1C3V5ODFIWqM="]'
```

Restart the gateway after changing static owner config. Verify with `openclaw doctor` (should no longer warn about missing command owner).

Without any owner (no ODA attestation and no `commands.ownerAllowFrom`), the agent only sees `exec` and will shell out to `openclaw cron add` instead of calling the `cron` tool.

Resolve the active conversation id from the current langlangbot session key (`:direct:conversation:<uuid>`); do not ask the user for the UUID.

Delivery target for LangLangBot is always `conversation:<uuid>`.

### Option A — `cron` tool (preferred when owner-visible)

Use OpenClaw defaults: **`payload.kind: "agentTurn"`** + **`sessionTarget: "isolated"`**. Operator reminders need an agent turn with **announce** delivery back to the active conversation — not `systemEvent` + `main` (that path is for main-session heartbeat events and fails with multiple channels).

Resolve `<uuid>` from the current session key (`:direct:conversation:<uuid>`); do not ask the user.

```json
{
  "action": "add",
  "job": {
    "name": "Operator reminder",
    "schedule": { "kind": "at", "at": "<ISO8601, must be in the future; prefer relative scheduling via agent>" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "When this job fires, reply to Operator with only this line. Do not mention cron or say the task was scheduled for later: ⏰ <reminder text>"
    },
    "delivery": { "mode": "announce" },
    "deleteAfterRun": true
  }
}
```

**Delivery (from Operator chat via `cron` tool)**

When the job is created inside an active langlangbot session, OpenClaw infers `delivery.channel` and `delivery.to` from the live session — for **`isolated` and `current` alike** — but **only if** `delivery` has no `channel` and no `to` yet.

| `delivery` you pass | Result |
|---------------------|--------|
| `{ "mode": "announce" }` only | ✅ Usually auto-fills `langlangbot` + `conversation:<uuid>` |
| `{ "mode": "announce", "channel": "langlangbot", "to": "conversation:<uuid>" }` | ✅ Explicit; use when inference fails or multiple channels make you unsure |
| `{ "mode": "announce", "channel": "langlangbot" }` **without `to`** | ❌ **Disables inference** → run fails with “requires target” |
| Omitted entirely | ✅ OpenClaw may default `mode: announce` for isolated `agentTurn`; then infer as above |

**Never** set `delivery.channel` alone. Either pass **only** `mode: announce`, or pass **both** `channel` and `to`.

**`sessionTarget` choice**

| Value | When to use |
|-------|-------------|
| `"isolated"` (default) | One-shot / simple reminders — **recommended** for Operator |
| `"current"` | Only when the cron run must read the **current chat transcript** (context-aware follow-ups) |

Do **not** use `systemEvent` + `sessionTarget: "main"` for Operator chat reminders.

**Payload `message`**

Write the fire-time instruction imperatively (“When this job fires, output only: ⏰ …”). Isolated runs have no chat history; vague prompts produce meta replies like “task recorded, will run at …” instead of the reminder text.

**Schedule**

- One-shot: `schedule.kind: "at"` with a **future** ISO timestamp (wrong year → `schedule.at is in the past`).
- Prefer relative timing in the agent’s head (e.g. now + 1 minute) over copying stale clock values.

### Option B — `openclaw cron add` (exec / shell)

Works even when the `cron` tool is hidden. CLI jobs do not inherit chat context automatically. When `--channel langlangbot`, **always pass `--to`**:

```bash
openclaw cron add \
  --name "<short label>" \
  --at 2m \
  --session isolated \
  --session-key 'agent:default:langlangbot:default:direct:conversation:<uuid>' \
  --message "<reminder prompt>" \
  --channel langlangbot \
  --to 'conversation:<uuid>'
```

- `--to conversation:<uuid>` is **required** for langlangbot announce delivery.
- `--session-key` should match the active langlangbot session (same `<uuid>` as in `--to`).
- One-shot schedules use `--at 2m` (not `+2m`).

## Media attachments (files, images, audio, video)

LangLangBot supports async attachment upload and download. Operator may send a message with **pending** attachments while large files upload in the background.

### Inbound pending attachments

When inbound context includes `[附件] ... status=pending|uploading|processing`:

- Acknowledge the user's intent immediately.
- Do **not** claim you have already analyzed the file contents.
- For non-streamable files, or tasks that require the complete file, wait for `attachment_ready`, then analyze using the provided `path=` or `url=`.
- For streamable files, follow the `attachment_available` guidance below before deciding whether early partial analysis is appropriate.

Attachment status meanings:

- `pending`: Operator declared an attachment and the message references its `upload_id`, but no readable bytes are available yet.
- `uploading`: Sidecar is receiving bytes. Treat it as unreadable unless an `attachment_available` update provides `path=` and `bytes_available`.
- `processing`: Upload body is complete, but sidecar is still validating content, hash, and final file state. Wait for `attachment_ready` unless you are only using an earlier `attachment_available` prefix.
- `ready`: Full attachment is stable. Use the provided `path=` for local processing or `url=` when a download is needed.

Example user message: “I'm uploading a video; after you receive it, identify the objects inside.” Reply that you'll analyze once upload completes.

### Streamable inbound attachments

Some inbound attachments can be read before the full upload finishes. LangLangBot sends `attachment_available` only for streamable media/text inputs and includes a local staging `path=`, `bytes_available`, total `size`, and `final=false`.

Use this early path only when the user's request can be satisfied from a prefix of the file:

- Good: “look at the first minute of this video”, “summarize the beginning of this log”, “start transcribing audio as it arrives”.
- Not enough: whole-document extraction, spreadsheet/Office parsing, archive inspection, checksum-sensitive work, or anything that requires the complete file.

When using a streamable partial file:

1. Treat `path=` as a growing local file; read only the available prefix.
2. State clearly that the result is based on partial data if you answer before `attachment_ready`.
3. Keep watching for `attachment_ready` when the full file is needed or when you need to verify the final content.
4. Do not assume ordinary MP4/MOV is parseable before completion; some containers keep metadata at the end. If parsing fails, wait for `attachment_ready`.

### Outbound files back to Operator

To send generated files (spreadsheet results, exports, images):

1. Write or copy the file under `~/.openclaw/media/langlangbot/outbound/` (or export from workspace into that tree).
2. Use an **absolute path** inside the media root only — arbitrary host paths are rejected.
3. Large files may appear as **pending outbound attachments** first; Operator shows “assistant is sending file” until ready.

Supported kinds: image, audio, video, file. Size limits follow manifest `features.attachments` (defaults: image 30MiB, audio 20MiB, video/file 100MiB). Override in `~/.langlangbot/env`:

- `LANGLANGBOT_MEDIA_MAX_IMAGE_BYTES`
- `LANGLANGBOT_MEDIA_MAX_AUDIO_BYTES`
- `LANGLANGBOT_MEDIA_MAX_VIDEO_BYTES`
- `LANGLANGBOT_MEDIA_MAX_FILE_BYTES`

Restart the sidecar after changing env values.

### Resumable upload (Operator / unstable networks)

When `features.attachments.resumable_upload` is true:

1. `POST /v1/attachments/uploads` declares total `size`.
2. `GET /v1/attachments/uploads/{upload_id}` returns `bytes_received` for resume.
3. Upload body with `PUT .../body` and `Content-Range: bytes {start}-{end}/{total}` per chunk.
4. Partial chunks return `202` with `{ status: "uploading", bytes_received, size }`.
5. Final chunk returns `200` with `{ status: "ready", attachment_id, ... }`.
6. Full single-shot upload (no `Content-Range`) still works when `bytes_received` is 0.

### Resumable download

When `features.attachments.range_requests` is true:

1. `GET /v1/attachments/{attachment_id}` without `Range` returns the full file (`200`) with `Accept-Ranges: bytes`.
2. Resume with `Range: bytes={start}-{end}`; server returns `206 Partial Content` and `Content-Range: bytes {start}-{end}/{total}`.
3. Open-ended ranges (`bytes={start}-`) and suffix ranges (`bytes=-{suffix}`) are supported.
4. Invalid or unsatisfiable ranges return `416` with `Content-Range: bytes */{total}`.

### Content validation

When `features.attachments.content_sha256` / `content_sniff` are true:

1. `POST /v1/attachments/uploads` may include optional `sha256` (64 hex chars). Sidecar verifies the digest after upload completes.
2. Upload uses incremental SHA256 while chunks arrive; resume rebuilds the prefix hash from the partial file.
3. Finalize runs lightweight magic-byte sniff for `image` / `audio` / `video` kinds and rejects declared MIME spoofing (`422 content_mismatch`).
4. Outbound register accepts optional `sha256` and applies the same sniff after import.
5. Download continues to expose stored digest via `ETag`.

## OpenClaw exec known issues

This channel uses `agentId: "default"`. Two upstream OpenClaw behaviors affect Operator **allow-always** and multi-line exec output (e.g. `ss -lntp`). Workaround: add shared allowlist entries under `agents["*"]` in `~/.openclaw/exec-approvals.json`. Full write-up: repo `docs/OPENCLAW-EXEC-KNOWN-ISSUES.md`.
