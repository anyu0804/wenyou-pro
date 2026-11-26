# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately through GitHub's [private vulnerability reporting](https://github.com/anyu0804/wenyou-pro/security/advisories/new) on `anyu0804/wenyou-pro`.

You can expect an initial response within a few days. Once confirmed, we will prepare a fix and credit you in the release notes if you wish.

## Scope & security boundaries

**Wenyou Pro (司命 · 文游 Pro)** handles sensitive LLM credentials, private campaign vaults, and local read-only chat bridges:

- **Provider credentials**: API keys are supplied via environment variables (referenced as `$VAR` in `models.json`) or local OAuth tokens and are never stored in this repository or bundled into releases.
- **User data directories**: Local agent state lives under `~/.wenyou-pro/agent/` (`~/.wenyou-pro/agent-dev/` and `~/.wenyou-pro/agent-beta/` for development and Beta builds; including `sessions/*.jsonl`, `auth.json`, and `permission-audit.jsonl`), and default campaign vaults live under `~/.wenyou-pro/worlds/`. Redact keys, tokens, NTQQ `key_map.json`, and private campaign data before sharing logs or issue reports.
- **Vault isolation & protocol gates**: `wenyou-asset://vault` workspace allowlists, `wenyou-sandbox://app` CORS/CSP restrictions, `maxViewer` / `:::secret[...]` disclosure clamping, and `tool_call` canon write-protection (`01-设定与国力实册/`, `03-国策与文书/`, `04-编年史与条约/`, `manifest.json`) are all security-critical boundaries (detailed in [ACCEPTANCE.md](ACCEPTANCE.md)).
- **Read-only NTQQ VFS**: The bundled NTQQ VFS scripts are strictly read-only and must never modify or lock QQ's encrypted source databases.
- **Repository hygiene gates**: Before contributing or releasing, run `npm run check:paths` (anti-doxxing and hardcoded local path gate) and `npm run repo:guard` (offline GitHub anti-lockout & workflow timeout verification).

Any code path that can leak API keys into logs/renderer/crash reports, bypass `wenyou-asset://` or `maxViewer` isolation, escape workspace boundaries via symlinks/path traversal, or silently mutate protected canon files without human approval is in scope and we welcome your report.
