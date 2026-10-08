# Three-agent budget POC

One manager and two market agents, `crypto` and `stocks`. Once a week the manager buys a performance report from each market agent and moves the user's budget between the three Cardano wallets. The budget token is Masumi's Preprod tUSDM. Every send is an x402 `exact` payment with `assetTransferMethod: "default"`. Report fees are a separate Masumi escrow and never include the budget.

Postgres database `hedge` stores the fund, the rounds, the reports, and the transfers. Database `masumi` is reserved for the payment service.

## 1. Run a local week

Docker and a copy of `.env` are enough. No Blockfrost key and no mnemonics. Transfers stay `pending` because nothing is signed.

```bash
cd poc
cp .env.example .env
docker compose up --build
```

Wait until `manager listening on 8080`. In another shell:

```bash
cd poc
curl -s -X POST localhost:8080/demo/seed -H "authorization: Bearer change-me"
curl -s -X POST localhost:8080/rounds -H "authorization: Bearer change-me" \
  -H "content-type: application/json" -d '{"week":"2026-09-28"}'
```

The week must be a Monday. That call is round 0. It ignores performance and stores weights `crypto` 0.40, `stocks` 0.40, `reserve` 0.20. Two transfers of `40000000` (40 tUSDM) go from the manager to each market agent. `txId` is null. `detail` is `missing_address` until `CARDANO_ADDRESS_CRYPTO` and `CARDANO_ADDRESS_STOCKS` are set. With those addresses set and no Blockfrost key, `detail` is `facilitator_unconfigured:BLOCKFROST_PROJECT_ID,MNEMONIC_MANAGER`.

The seed deposit is a Postgres row, `txId` `demo-deposit`, for 100 tUSDM. It is not a chain transaction. `POST /demo/confirm-transfers` is the same kind of stand-in: it marks pending rows confirmed so the next week can run. It does not submit anything.

```bash
curl -s -X POST localhost:8080/demo/confirm-transfers -H "authorization: Bearer change-me"
curl -s -X POST localhost:8080/rounds -H "authorization: Bearer change-me" \
  -H "content-type: application/json" -d '{"week":"2026-09-28"}'
curl -s -X POST localhost:8080/rounds -H "authorization: Bearer change-me" \
  -H "content-type: application/json" -d '{"week":"2026-10-05"}'
```

The second Monday reads the seeded daily snapshots. Crypto rose about 1% a day and stocks fell about 1% a day, so the round moves `10000000` (10 tUSDM) from stocks to crypto. A share stays between 10% and 50%, a move under 5 points is dropped, and a weekly step is at most 10 points.

`GET localhost:8080/fund` shows the budget total. Reads are open. `POST` routes need `authorization: Bearer` matching `OPERATOR_TOKEN`.

Reset the databases with `docker compose down -v`.

## 2. Environment variables

| Name | Used by | Required |
|---|---|---|
| `OPERATOR_TOKEN` | manager writes | yes |
| `DEMO_SEED` | `POST /demo/seed` and `/demo/confirm-transfers` | `true` only for the local walkthrough |
| `MASUMI_MODE` | report purchase | `local` or `live` |
| `BUDGET_UNIT` | every transfer | Preprod tUSDM, see `.env.example` |
| `REPORT_FEE` | live report escrow | minor units, default `1000000` |
| `BLOCKFROST_PROJECT_ID` | facilitator | a Preprod project from blockfrost.io, for real sends |
| `BLOCKFROST_URL` | facilitator | defaults to the Preprod API |
| `MNEMONIC_MANAGER`, `MNEMONIC_CRYPTO`, `MNEMONIC_STOCKS` | facilitator | 24-word cardano mnemonic for that wallet |
| `CARDANO_ADDRESS_MANAGER`, `CARDANO_ADDRESS_CRYPTO`, `CARDANO_ADDRESS_STOCKS` | manager | `addr_test1...` for the same mnemonics |
| `PAYMENT_SERVICE_URL` | live reports | `http://payment:3001` inside compose |
| `PAYMENT_API_KEY` | live reports | payment-service API key |
| `AGENT_IDENTIFIER_CRYPTO`, `AGENT_IDENTIFIER_STOCKS` | live reports | registry id, at least 57 characters |
| `SELLER_VKEY_CRYPTO`, `SELLER_VKEY_STOCKS` | live reports | selling-wallet verification key |
| `ENCRYPTION_KEY` | payment service | at least 32 characters |
| `ADMIN_KEY` | payment service | admin API key |
| `BLOCKFROST_API_KEY_PREPROD` | payment service | same Preprod project, payment service's own name |

`@x402/cardano` also knows a different Preprod USDM policy (`e675b46e...`). This POC does not use it. The unit above is the one `masumi-payment-service` calls tUSDM.

## 3. Send real tUSDM

1. Create a Blockfrost Preprod project. Put the key in `BLOCKFROST_PROJECT_ID` and `BLOCKFROST_API_KEY_PREPROD`.
2. Generate three wallets. Put each 24-word phrase and its `addr_test1` address in the matching `MNEMONIC_*` and `CARDANO_ADDRESS_*` pair.
3. Fund each address with Preprod ADA from the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/). The payer needs about 0.17 ADA of fee plus about 1.17 ADA that travels with the token and comes back when the receiver spends it. Keep at least 5 ADA on a wallet that will also sell reports.
4. Fund the manager with tUSDM from the [Masumi dispenser](https://dispenser.masumi.network/). The market wallets need a tUSDM balance only after they have received a send, and again before a later week makes them the sender.
5. Leave `DEMO_SEED` unset or `false`. Record the operator's deposit instead of the demo row:

```bash
curl -s -X POST localhost:8080/deposits \
  -H "authorization: Bearer change-me" -H "content-type: application/json" \
  -d '{"amount":"100000000","txId":"<cardano tx id>"}'
```

6. `docker compose up --build` again so the facilitator sees the key and the mnemonics.
7. `POST /rounds` with a Monday. The facilitator signs `exact` / `default`, broadcasts, and writes `txId` on the transfer while it is still `pending`. A retry of the same week polls Blockfrost and does not sign a second transaction. When the tx is visible, `status` becomes `confirmed`.
8. The next Monday is rejected while any transfer from the previous week is not `confirmed`.

A market agent whose latest snapshot shows less tUSDM on Cardano than the send calls `POST /free` on the gateway. That route is a stub and returns 501, and the transfer stays `pending` with `detail` `needs_free`. Put the weekly amount on Cardano before the round. Solana trading is not in this POC.

## 4. Masumi report fees

`MASUMI_MODE=live` makes the manager pay `REPORT_FEE` into escrow for each report. The market agent submits the result hash only after the payment service reports `FundsLocked`.

```bash
docker compose --profile masumi up --build
```

That starts `ghcr.io/masumi-network/masumi-payment-service` against database `masumi`, runs `pnpm run prisma:migrate`, and listens on port 3001. Set `ENCRYPTION_KEY` before the first start. Losing it makes the service's copy of its hot wallets unreadable.

Seed the service wallets once, from the payment-service directory or with the image's seed script, using `BLOCKFROST_API_KEY_PREPROD`. Register `crypto` and `stocks` in the admin UI at `http://localhost:3001/admin/` on contract V2, priced in tUSDM at `REPORT_FEE`. Copy each agent identifier and selling verification key into `.env`. Point each registry `apiBaseUrl` at a public URL only if a buyer outside this machine will open the agent. The manager calls `http://crypto:8081` and `http://stocks:8082` on the compose network either way.

Poll intervals in this compose file are 20s, 30s, and 1 confirmation. The upstream `.env.example` is much slower.

List payment-service rows with `filterPaymentSourceType=Web3CardanoV2`. Without that filter, V2 payments stay hidden.

## 5. Tests

The weight rules and the round state machine are covered without Docker:

```bash
cd poc
npm install
npm test
```
