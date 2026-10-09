# Hedge desk

A manager splits a tADA fund across four trading agents (btc, eth, spx, gold). Agents trade on a simulated broker. Every move of money between wallets is a real Cardano Preprod transaction. See `LAYERS.md` for the module map and the cycle.

| process | port | does |
|---|---|---|
| manager | 8080 (HTTP) | Runs the cycle loop. `POST /start`, `POST /stop`, `GET /state`, `GET /desk` (full snapshot for the UI). |
| btc, eth, spx, gold | 8081–8084 (WebSocket) | Deposit to the broker, trade with the manager's strategy, withdraw on stop, report. |
| broker | 8090 (WebSocket) | Simulates prices every second, keeps accounts, fills orders, checks deposits on chain, pays withdrawals. |
| postgres | 5432 | All state. Any process can restart and continue. |
| ../web | 3000 | Fund console. The **Live desk** tab shows agents, cycles, transactions, Start and Stop. |

## Run

```bash
cp .env.example .env        # fill BLOCKFROST_PROJECT_ID, GEMINI_API_KEY, MNEMONIC_MANAGER
npm install
npm run wallets             # generates missing wallets, tops each up to WALLET_RESERVE_ADA from the manager
docker compose up --build -d
cd ../web && npm ci && npm run dev
```

`../web/.env.local` needs `MANAGER_URL=http://127.0.0.1:8080` and `MANAGER_TOKEN` (same value as `OPERATOR_TOKEN` here). Open http://localhost:3000, choose **Live desk** in the sidebar and press Start. Behind a TLS-inspecting proxy, put its root certificate in `.zscaler-root.pem` and set `NODE_EXTRA_CA_CERTS` for `npm run wallets`. `docker-compose.override.yml` mounts it into every container.

## Money

- Every wallet keeps `WALLET_RESERVE_ADA` for fees. Agents deposit everything above it.
- The manager allocates `FUND_ADA` plus whatever agents hold. Its own wallet can hold more; only that amount is in play.
- The broker starts with `BROKER_HOUSE_ADA`. Simulated profits are paid from it and losses stay in it. If it runs short, the unpaid part stays as the agent's cash at the broker.
- Gemini proposes shares. Code bounds them for the demo: every agent gets 10–50%, the reserve stays at 5–20%, and a share moves at most 30 points per cycle. Moves under 2 tADA are skipped.

## Timing

One wallet sends one transaction at a time and waits for it to land, about 20–60 s on Preprod. Stopping four agents means four broker withdrawals in a row, so a cycle's stop phase takes a few minutes. Keep `CYCLE_MINUTES` well above that.

## Restart

- Each transfer has a fixed id (`c<cycle>-<step>-<role>`). A retry after a crash finds the row and waits for its transaction instead of sending again.
- The manager resumes the open cycle from its phase.
- An agent resumes depositing or trading from `agent_state`. A withdrawal finishes when the manager sends stop again.
- The broker reloads accounts and the last prices.
- **Stop** stops the loop and tells every agent to stop and withdraw. **Start** opens a fresh cycle.

## Checks

```bash
npm test
npm run typecheck
npm run lint
```
