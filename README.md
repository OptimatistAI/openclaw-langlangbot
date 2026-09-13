# openclaw-langlangbot

OpenClaw channel plugin and TypeScript client for **LangLangBot** — chat with the LangLang
Operator app, stream agent replies, and route exec/plugin approvals to the same client.

## Packages

| npm package | Role |
|-------------|------|
| `@optimatist/langlangbot-connector` | HTTP/SSE client for the LangLangBot sidecar API |
| `@optimatist/langlangbot-openclaw` | OpenClaw channel plugin (bundles the connector) |

Requires **Node.js ≥20** and **OpenClaw ≥2026.5.7**.

## Install

Sidecar binary and OpenClaw plugin (Linux and macOS Apple Silicon):

```bash
curl -fsSL https://optimatist.ai/langlangbot/install.sh | bash
langlangbot pair ABC2-T9K4
```

Plugin only:

```bash
openclaw plugins install @optimatist/langlangbot-openclaw@latest
openclaw gateway restart
```

See [docs/INSTALL.md](docs/INSTALL.md) and [docs/CONFIG.md](docs/CONFIG.md).

## Data path

```text
Operator app → LangLangBot sidecar → this plugin → OpenClaw Agent → sidecar outbound → Operator
```

## Develop

```bash
npm ci
npm run build
```

CI runs package checks on pull requests. Publish via GitHub tag `npm-v*` or `bash scripts/publish-oss-npm.sh`.

## License

MIT — see [LICENSE](LICENSE).
