# Install

## One-line setup (Linux and macOS)

Installs the LangLangBot sidecar binary and this OpenClaw plugin, then configures
`~/.openclaw/openclaw.json` (default sidecar URL `https://127.0.0.1:9528`).
The installer is published at `https://optimatist.ai/langlangbot/install.sh`
(source: `OptimatistAI/langlangbot`). Pass `--runtime openclaw` if both OpenClaw
and Hermes are on PATH.

```bash
curl -fsSL https://optimatist.ai/langlangbot/install.sh | bash
```

## Pair with Operator

After install, run the pair command shown in the LangLang Operator app:

```bash
langlangbot pair ABC2-T9K4
```

Copy the command as displayed (8-character short code). Tap approve on the phone
after checking hostname / IP / OS / TLS fingerprint; do not type a confirmation
code. Scripts may still use `langlangbot pair --id <base64>`.

## Plugin only

If the sidecar is already installed:

```bash
openclaw plugins install @optimatist/langlangbot-openclaw@latest
openclaw gateway restart
openclaw channels status
```

## Verify plugin load

```bash
node -e "import('$HOME/.openclaw/extensions/langlangbot/dist/index.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

Rebuild and reinstall after local changes:

```bash
npm run build
openclaw plugins install . --force   # from packages/openclaw
openclaw gateway restart
```
