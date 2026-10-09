# HedgeAgents

A one-operator fund console and agent runtime following [the architecture](docs/ARCHITECTURE.md) and [decisions](docs/DECISIONS.md). Python 3.11, Postgres, Next.js, and a Node Cardano x402 facilitator. **Podman only; no Docker daemon or Docker Compose is used.**

## Run locally

Run commands from this directory, the directory containing this README and `pyproject.toml`.

Prerequisites: Python provisioning through `uv`, Node.js 24+, and a running Podman machine. On Windows, `podman machine start` starts an existing machine.

```powershell
uv sync --all-groups --frozen
npm --prefix web ci
npm --prefix agents/facilitator ci
npm --prefix agents/facilitator run build
uv run python -m infra.manage init
uv run python -m infra.manage postgres
uv run python -m infra.manage init-db
uv run python -m runtime.replay --data-dir "../../market-data-scraper/output"
```

In separate terminals:

```powershell
uv run python -m infra.run monitor
uv run python -m infra.run core
uv run python -m infra.run web
```

Open **http://127.0.0.1:3000**. API documentation: **http://127.0.0.1:8000/docs**.

The default experience is a four-asset historical-price paper replay. Set `--data-dir` to the folder containing your BTC, ETH, gold, and SPYx JSON files; the relative path above matches this workspace. Replay uses the supplied Binance daily BTC/ETH candles, GeckoTerminal SPYx daily candles, and GoldAPI XAU/USD observations. Gold is a price proxy, not historical PAXG fills. Prices only become available after the candle closes or observation timestamp, and source-error/unfinished rows are excluded with counts shown in the console.

The first import saves a local normalized cache. Later `uv run python -m runtime.replay` runs reuse that cache; use `--data-dir` again to import changed files. Original files are never modified, and there is no network price fallback. Twelve authored score points and the bounded allocator generate simulated trades. Replay never uses chain keys, writes live events, or creates a live deposit.

Read-only access needs no token. Connect the operator using `OPERATOR_TOKEN` from your local, untracked `.env`. The browser keeps it only in page memory. Do not enter wallet seeds in the browser or chat.

## Verify

```powershell
uv run python -m infra.setup verify
uv run python -m infra.manage doctor
uv run python -m infra.manage check-compose
```

Verification runs Python tests, real Postgres concurrency/permission checks in disposable databases, Python lint, facilitator build/tests, web lint, and the production web build. Only a successful complete run records the offline gate. It does not certify the real-chain gates or arm trading.

## What is ready

- Responsive console: overview, team charts, replay player, audit, policy chat, public wallets, capital controls, inventory, and readiness.
- Decimal bounded allocation, cap repair, stops, ownership-unit accounting, fee recognition, and cash-out identities.
- Durable gateway intents, receipt deduplication, wallet attempts, original-chain refunds, recovery, ordered allocation legs, and a database-enforced append-only audit chain.
- Scoped trader/gateway MIP-003 endpoints, V2 fee-job client, Jupiter Swap v2 adapter, Solana signer, Cardano exact/default facilitator, sampler, and one runtime scheduler.
- Operator-confirmed pending policies, explicit deploy/cash-out requests, and bounded qualification that leaves normal automation off.

## Live qualification is still required

**This is a runnable local application, not a mainnet-qualified fund.** No chain wallets or API credentials are supplied, and no real escrow job, x402 transfer, or Jupiter fill has been executed by this build. Preprod/devnet and mainnet qualification remain blocked until you configure and verify them. The Payment Service is defined but is not automatically started with generated wallets.

The integration boundaries and remaining qualification work are documented in [the runbook](docs/RUNBOOK.md). Do not treat passing mocked adapter tests as evidence of a real chain transaction, or the replay return as live profit.

## Containers

The default local workflow runs Postgres on Podman and application processes on the host. A complete application Compose definition is also supplied:

```powershell
uv run python -m infra.manage podman-app
```

Stop host application processes first to free ports 3000 and 8000. This command does not start the credential-dependent Masumi Payment Service. Start that separately only after the runbook's wallet and credential setup. Container registry names and upstream `Dockerfile`/Compose `dockerfile` keys are artifact formats; the engine/provider is Podman.

## Layout

`agents/common` holds the financial and protocol rules. `agents/trader`, `agents/gateway`, and `agents/facilitator` own signing and recovery. `runtime` schedules and builds the paper tape. `monitor` is keyless HTTP/read-model infrastructure. `web` is the Next.js console. `infra` contains Podman setup, restricted roles, launchers, and qualification commands.