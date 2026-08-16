# exo-dev-factory

LLM trace observability app, governed by an autonomous-development
contract: the `exo-dev-bot` account can open Issues, branches, and PRs
against this repository within the boundaries defined in
[`AUTONOMY.md`](AUTONOMY.md).

## What this repo contains

- **Web app** — a Hono + React seed for collecting and viewing LLM traces.
- **Autonomy contract** — `AUTONOMY.md` plus the machine-readable policies in
  `.autonomy/` (product, quality gates, issue policy, community scan) and the
  coordinator instructions in `.autonomy/prompts/coordinator.md`.
- **Intake & CI** — issue templates, security/contribution policies, a pinned
  secret scanner (gitleaks), and governance workflows that keep bot-authored
  PRs off protected paths.
## Quick start

```bash
pnpm install
pnpm build
pnpm start   # http://localhost:8787
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Server with hot reload (tsx watch, :8787) |
| `pnpm dev:client` | Vite dev server with HMR |
| `pnpm typecheck` | TypeScript across server, client, and tests |
| `pnpm unit` | Unit tests (vitest, `tests/unit`) |
| `pnpm integration` | Integration tests (vitest, `tests/integration`) |
| `pnpm build` | Compile server + bundle client |
| `pnpm smoke` | Boot built server and assert the API contract |
| `pnpm start` | Run the built server |

## Security

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/exologica/exo-dev-factory/security/advisories/new)
— see [`SECURITY.md`](SECURITY.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
