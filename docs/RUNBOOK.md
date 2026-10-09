# Operations and Qualification

## Verified local boundary

The application has been run on Windows with Python 3.11, Node 24, and Podman Postgres 17. The console, monitor, runtime, gateway, facilitator, and four trader processes start locally without chain keys. Desktop and mobile browser checks cover rendered charts/assets, navigation, and replay/live isolation. Offline tests cover the architecture's numerical examples, receipt validation, recovery, authentication, role separation, and concurrent database reservations.

The chain adapters are implemented but **not certified against funded wallets**. No Preprod/devnet or mainnet gate should be recorded until the corresponding real test has run. The local UI says play money; all normal signing begins disarmed and halted.

## Local commands

See [README](../README.md) for first startup. Commands are run from the project directory.

| Command | Purpose |
|---|---|
| `uv run python -m infra.manage init` | Generate local database/service/operator credentials; preserve an existing `.env` |
| `uv run python -m infra.manage postgres` | Start and health-check Postgres with Podman Compose |
| `uv run python -m infra.manage init-db` | Create `hedge` and `masumi`, schema, restricted roles, and audit triggers |
| `uv run python -m runtime.replay --data-dir "../../market-data-scraper/output"` | Import the user's four historical JSON files and replace paper tables only |
| `uv run python -m runtime.replay` | Rebuild paper tables from the imported local cache; no downloads |
| `uv run python -m infra.run monitor` | Keyless monitor on port 8000 |
| `uv run python -m infra.run core` | Runtime, gateway 8082, facilitator 8084, traders 8101-8104 |
| `uv run python -m infra.run web` | Next.js on port 3000 |
| `uv run python -m infra.setup verify` | Full local checks and an offline acceptance record |
| `uv run python -m infra.manage doctor` | Connection/configuration status, without printing credentials |

Individual services can also be launched through `infra.run`. Stop them with Ctrl+C. The core launcher stops its children if one exits. Host credentials are filtered per child process; do not replace these commands with an unfiltered whole-environment signer launch.

## Historical replay input

Replay now uses the operator-supplied output folder, including gold, instead of the original three-asset downloaded tape. BTC and ETH use daily candles available after `closeTime`; SPYx uses daily OHLCV candles available one day after their opening `date`; gold uses its XAU/USD observation timestamp and `price`. Only observations available at or before each frame are used. The last known gold observation can be carried forward across missing days, with its actual timestamp retained on the frame.

The importer requires all four files, validates finite positive prices and candle ranges, excludes unfinished candles, and records source errors or duplicate rows explicitly. Conflicting duplicate observations and malformed prices fail before the replay database is replaced. The console's Historical data panel shows file hashes, accepted/excluded row counts, and the timestamps of prices used. The initial import accepted 91 BTC, 91 ETH, 91 gold, and 99 SPYx observations; it excluded two gold source errors and the unfinished daily candle in each of the other three files.

These are historical price inputs, not settled fund receipts. Gold's XAU series remains labeled as a price proxy. The replay retains its authored score scenario, adds a gold score series, and never writes to live books or the Masumi audit. `--refresh` requires `--data-dir`; an old downloaded cache is not silently reused.

## Wallets and credentials

Use distinct wallets on each environment. Never reuse a seed across capital, purchasing, selling, or another agent.

1. Choose `preprod` + Cardano `preprod` + Solana `devnet`. A mainnet deployment uses a separate database and the `mainnet`/`mainnet` pair. Do not repoint a funded database to the other network.
2. Securely create/back up three Cardano wallets and one Solana wallet per agent. Include the gateway. Purchasing and selling each need collateral and fee float; capital needs its own fee/min-UTxO float. Keep gateway inventory separate from fund assets.
3. Populate a private local copy of [the public manifest](../infra/wallets.example.json). A wallet row contains `id`, `agent_id`, `chain`, `role`, and `address`. Use roles `capital`, `purchasing`, `selling`, `trading`; the gateway's Solana role is `gateway_inventory`. The operator's cash-out address is `agent_id: operator`, `chain: cardano`, `role: distribution`. The manifest has **no secret fields**.
4. Add signer secrets directly to `.env`: `BTC_CAPITAL_MNEMONIC` through `GATEWAY_CAPITAL_MNEMONIC`, and `BTC_SOLANA_PRIVATE_KEY` through `GATEWAY_SOLANA_PRIVATE_KEY`. Solana supports a base58 keypair or a JSON byte array. The facilitator gets capital mnemonics only; each Python signer gets only its own Solana key.
5. Configure `BLOCKFROST_PROJECT_ID`, `SOLANA_RPC_URL`, `DEVNET_USDC_MINT`, `JUPITER_API_KEY`, and `LLM_API_KEY`. A devnet USDC mint is explicitly configured; mainnet USDC is never substituted for it. Real Jupiter swaps are mainnet-only. Mainnet ADA network-fee valuation also needs an explicitly verified `ADA_PRICE_MINT` on Jupiter; missing confirmation-time marks block accounting rather than inventing fees.
6. Import public addresses while halted: `uv run python -m infra.setup import-wallets path/to/wallets.json`. Existing ownership cannot be silently overwritten and unresolved attempts block the operation.
7. A stocks operator must be eligible to hold xStocks and explicitly set `XSTOCKS_ELIGIBLE=true`. The application does not establish legal eligibility.

For Mode 1, create a fresh configuration with `FUND_MODE=1` and one `ACTIVE_AGENTS` value before initializing the database. Mode 2 requires two to four sleeves; adaptive allocation needs at least three. The full container profile starts all four trader containers; use the host per-service launcher for a reduced configuration.

## Masumi Payment Service

[The Podman service definition](../infra/compose.masumi.yml) pins upstream commit `d569a338ca54d5be7441564770d75ebf89b71f12`. Its build is substantial; allow at least 6 GB of VM RAM. The full container build was not executed as part of the keyless local run.

Configure `MASUMI_BLOCKFROST_PREPROD`, `MASUMI_PURCHASING_PREPROD`, and `MASUMI_SELLING_PREPROD` with the selected gateway fee wallets; use the corresponding `MAINNET` variables for mainnet. Keep the other environment's Blockfrost key empty. The startup helper rejects missing seed wallets because upstream otherwise generates and prints mnemonics. Back up `ENCRYPTION_KEY` before the first restart.

```powershell
uv run python -m infra.manage masumi
```

Apply upstream Prisma migrations/seeding according to that pinned version before processing jobs. Import the remaining purchasing/selling wallets through its local admin interface, and create **wallet-scoped** payment keys for each buyer/seller pair. Place these in `BTC_PAYMENT_KEY`, `ETH_PAYMENT_KEY`, `GOLD_PAYMENT_KEY`, `STOCKS_PAYMENT_KEY`, and `GATEWAY_PAYMENT_KEY`. `PAYMENT_READ_KEY` is the monitor/runtime read-only key. No capital wallet is imported to the Payment Service.

Register each seller on V2 with a positive flat service price. Import its registry entry into the manifest using `agent_id`, `identifier`, `seller_vkey`, `supportedPaymentSources`, and optional `api_url`. The selected source must be Cardano, the exact environment, the V2 settlement address, and the exact flat price/unit. Gateway fee default: 100000 raw stablecoin units. Report fee: 10000. Restart the agent after registration so the SDK HTTP shell is initialized with the registered identity.

Required poll settings are explicitly 20 seconds (`CHECK_TX_INTERVAL`), 30 seconds (`BATCH_PAYMENT_INTERVAL`), and one confirmation. All records are V2-filtered. Creation uses +5/+16/+31/+46-minute deadlines; purchase uses the exact returned terms. The normal unlock is +31 minutes, not the external-dispute +46 minutes.

## Qualification

1. Run `infra.setup verify`. Its offline gate is written only if all tests, including Postgres tests, and builds pass.
2. Fund the small Preprod/devnet protocol test, gateway inventory, and fee reserves manually. Reconcile inventory from Controls. Clear the halt separately. Use **bounded qualification** in Capital operations; it authorizes one durable operation for at most five units for one hour, never the normal scheduler.
3. Verify registry entries, a real fee escrow cycle through result submission/unlock, one tUSDM exact/default x402 payment, devnet USDC ATA/transfer behavior, and restart/late-confirmation adapter cases. A devnet Jupiter fill is not expected or claimed.
4. Record each real gate with `uv run python -m infra.setup record-gate GATE evidence.json`. The file is an explicit **operator attestation**, not a substitute for a chain test. It requires `environment`, `verified_by: operator`, `receipts`, and a `checks` object containing only passing booleans. Keep raw receipts and chain cursors with it.
5. On a separate mainnet deployment, repeat configuration and import the verified Preprod evidence. Explicitly authorize a few-dollar deploy/buy/sell/withdraw/cash-out qualification. Reconcile all wallets, claims, prepayments, liabilities, actual fees, and cash-flow PnL before recording `mainnet_qualification`. That evidence additionally requires `budget_usd <= 5`, `checks.reconciled_raw_balances`, and `checks.cash_flow_pnl_identity`.
6. Only then call authenticated `POST /arm` with `confirmation: ARM MAINNET`. Clearing a halt never arms automatically. No command in this runbook purchases assets without your explicit authorization and funded credentials.

## Recovery

- Do not delete attempts, claims, or reservations to clear a busy wallet. One missing RPC result is unknown, not failure.
- Source, payout, and refund attempts retain their original transaction IDs and signed bytes in signer-only storage. Recovery may only resolve those operations. New wallet work is blocked until resolution.
- A timeout does not refund principal. A payout must be confirmed failed or proven expired with complete history and unchanged balances/unspent inputs before a replacement or refund is permitted.
- Refunded receipts stay consumed forever. Deposit refunds return Cardano stablecoin; withdrawal refunds return Solana USDC. The MIP-003 fee refund is a separate operation.
- A provider unable to establish complete history leaves the reservation held. Escalate to manual reconciliation instead of guessing.
- Never use a second active capital signer. The plain-transfer fallback requires stopping the facilitator, resolving attempts, and an audited exclusive ownership handoff.

## Current Integration Limits

These are visible, unqualified boundaries, not claimed successes:

- No funded real-network adapter/recovery run has been completed. The Payment Service deployment, registration, and wallet-scoped credentials require operator setup.
- Live buy-and-hold and fixed-shadow benchmark lots track contributions and proportional withdrawals. Missing contribution/redemption-time marks leave a visible pending benchmark and require historical backfill; no live comparison is fabricated from replay data.
- Stablecoin accounting uses the stated six-decimal, one-for-one nominal exchange unit. Mainnet depeg/cross-rate attribution is not implemented; do not claim exact USD valuation in a depeg.
- Runtime objections currently report recomputed local safety state, not an optional LLM comment. News ingestion and emergency tagging from an external feed are not enabled. Trader signals use the stored Jupiter marks.
- Cash-out is explicit and partial: it leaves a one-unit reserve, returns available principal, and splits the receipt between expense repayment and distribution. An automatic full fee-reserve sweep/closure is not provided.
- Missing confirmation-time fee marks or a missed UTC baseline fail closed and require backfill/reconciliation. The system never fabricates a fee or NAV to unblock trading.
- Paid report anchoring is scheduled at runtime boundaries only when normal automation is armed and a separate report-fee reserve exists. Confirm a real anchor from `/status` and the V2 result hash before treating the local chain as externally anchored.

These limits are why normal mainnet signing stays gated. Complete the corresponding integration work and evidence before arming real capital.

## Windows TLS and Podman

Use `uv --native-tls sync` if a corporate certificate is trusted by Windows but not uv's bundled store. For Podman, verify the registry issuer, export its **existing trusted public root**, and install it in the Fedora VM with `trust anchor` and `update-ca-trust extract`. If VM `curl` succeeds but image pulls still fail, restart the active Podman API service so it reloads its CA cache. Do not disable TLS verification or transmit a private key.

Bitcoin and Ethereum bitmap marks are from `spothq/cryptocurrency-icons` (CC0). Charts are generated from the stored tape. All operator controls use Lucide icons, and fonts are locally bundled.