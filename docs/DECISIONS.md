# Decisions

Status of every decision in [PLAN.md](../PLAN.md), checked against Masumi, Cardano, Jupiter, and Solana as of 8 October 2026. The rule under each item is what we build. [ARCHITECTURE.md](ARCHITECTURE.md) is the system that follows from these rules.

Sources for the Masumi checks: `masumi-payment-service` at `d569a33` (6 Oct 2026), `pip-masumi` 1.2.0, `@x402/cardano` 2.28.0, and the masumi.network docs fetched the same day. Token mints and Jupiter quotes were read live the same day. `virattt/ai-hedge-fund` was read at v2.5.0 (`78b779c`, 2 Oct 2026) and at the last v1 tag (`v2026.7.10`).

## How to read a status

- **Kept.** The original default stands. The rule restates it so implementation does not drift.
- **Corrected.** The original default is wrong or only half true. The rule replaces it.
- **Added.** Not in PLAN.md. Required once the rest of the system is specified.

## D1 — Where trading happens

**Kept.** Solana mainnet, Jupiter Swap API v2, for gold, stocks, ETH, and BTC. Cardano holds budget and Masumi payments. It does not host the markets.

Cardano still has no tokenized US stocks with usable liquidity. Wrapped BTC and ETH pools there are too small for a demo that is supposed to show real fills. The four markets below were quoted on Jupiter on 8 Oct 2026 at $1k and $10k. All of them clear a $100–500 clip. Gold is the thin one.

| Market | Token | Mint | Program | Notes |
|---|---|---|---|---|
| Gold | PAXG (Paxos, native on Solana since 25 Jun 2026) | `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` | Token-2022 | Freeze and permanent delegate set. Transfer fee 0, transfer hook not attached. Jupiter liquidity about $343k. All-in gap about 0.17% at $1k and 0.29% at $10k. |
| Stocks | xStocks, one of SPYx, NVDAx, QQQx, TSLAx, AAPLx | see below | Token-2022 | Freeze and permanent delegate set. Transfer hook authority exists, `programId` null, mint not paused. |
| ETH | Wormhole WETH | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` | SPL Token, 8 decimals | No freeze. Jupiter liquidity about $21M. Gap about 0.07% at $1k and $10k. |
| BTC | cbBTC (Coinbase) | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` | SPL Token, 8 decimals | Freeze set. Jupiter liquidity about $28M. Gap about 0.04% / 0.09%. |
| Cash on Solana | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token, 6 decimals | Freeze set (Circle). |

xStock mints:

| Token | Mint | Jupiter liquidity | $1k / $10k gap |
|---|---|---|---|
| SPYx | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | $4.7M | 0.12% / 0.12% |
| NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | $4.0M | 0.12% / 0.13% |
| QQQx | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` | $2.0M | 0.17% / 0.18% |
| TSLAx | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | $1.5M | 0.34% / 0.35% |
| AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | $0.67M | 0.27% / 0.29% |

Default stock is SPYx. NVDAx is the alternate if we want a single name. TSLAx and AAPLx are liquid enough at demo size and more expensive.

**Rule.** One allowlisted mint per trader, plus USDC. Anything else is rejected before a transaction is built. Valuation uses Jupiter Price API v3 (`GET https://api.jup.ag/price/v3`). Swaps use `GET /swap/v2/order` then `POST /swap/v2/execute` on `https://api.jup.ag`. The v6 quote host does not resolve. `lite-api.jup.ag` returned 503 on the check day. v1 `/quote` still answers and is not used.

**XAUt0 is not the gold default.** `AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P` exists, is classic SPL, and quoted slightly tighter, on about $214k of liquidity. PAXG is the issuer-native mint. XAUt0 is a backup only if PAXG quotes break.

**Wormhole WBTC is not the BTC default.** `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` has a deeper book (about $38M) and no freeze. cbBTC has the tighter quote and Coinbase 1:1 custody. Native BitGo WBTC (`5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ`), zBTC, and tBTC are too thin for a clean $10k and are out.

**Jupiter key.** Keyless traffic is 0.5 requests per second (30 per minute). A free portal key is 1 rps and is required in setup so a quote burst does not 429. Four agents polling price once a minute fit in either tier. `/swap/v2/execute` has its own, higher bucket.

## D2 — Which Masumi network

**Corrected.** PLAN.md said develop on Preprod and then go live on Mainnet, and it warned that Preprod would turn test tokens into real USDC. The warning is right. The fix is two environments that never share a wallet, a stablecoin, or an RPC.

| | Preprod | Mainnet |
|---|---|---|
| Purpose | Prove registry, escrow, and x402 wiring | Real budget, real swaps, the PnL check |
| Masumi contract | V2 only | V2 only |
| Stablecoin | tUSDM | USDCx |
| Unit (policy id + asset name hex) | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde` + `0014df10745553444d` | `1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34` + `5553444378` |
| Solana | Devnet, for ATA and transfer plumbing only | Mainnet |
| UI label | Play money | Live |

USDCx is Circle xReserve: a Cardano native asset backed 1:1 by USDC locked in xReserve. It went live on Cardano mainnet on 27 February 2026. Policy and asset name above match Circle's docs and Masumi's `MAINNET_USDCX_UNIT`. Six decimals. Preprod USDCx exists at policy `31dde3db98ad05feb688d4dbb146b3b6054e1246cbcef98c79b0bf66`, but Masumi's dispenser and tooling use tUSDM, so Preprod flows use tUSDM.

**Rule.** A process refuses to start if its Cardano network and its Solana cluster disagree with the configured environment. The first Jupiter swap test is a few dollars on Solana mainnet. Devnet Jupiter does not have these markets, so a devnet swap cannot prove a fill. Net profit matching the wallets is a mainnet check only.

**There is no live Cardano–Solana bridge to restock the gateway.** Wanchain was the direct route. Its Cardano bridge was exploited on 20 July 2026, and on 8 Oct 2026 its token-pair API listed neither Cardano nor Solana. xReserve can mint USDCx from USDC in about 15–25 minutes and burn it back in about 2 hours (about 400 Cardano confirmations, then a relay). That is how we fund the gateway before the demo. It is not a step in the trade path. Rosen Bridge does not route to Solana.

## D3 — How agents move budget

**Corrected.** PLAN.md asked for Masumi x402 direct payments in USDCx: about 20 seconds, about 0.17 ADA, no 5% fee. The chain part is real. The "Python agents do this through the Payment Service" part is not.

What exists:

- `@x402/cardano` implements the x402 `exact` scheme on `cardano:mainnet`, `cardano:preprod`, and `cardano:preview`. The asset is ADA or any native token (`policyId.assetNameHex`). Docs describe settlement as final in roughly twenty seconds. The package confirms on one block, with a 75 second timeout, and can return `settlement_pending` until that block.
- `assetTransferMethod: "default"` is a signed wallet-to-wallet transaction. Nothing in the docs or the payment-service code charges a Masumi fee on it. The cost is the Cardano fee, about 0.17 ADA for a simple transaction, plus min-UTxO (see the cost note below).
- `assetTransferMethod: "masumi"` locks into the deployed V2 `vested_pay` contract. The package README says a lock it creates cannot be driven by a Payment Service node: the `reference_signature` covers a different `termsDigest`, so purchase-init rejects it. Result submission and refunds would have to be done with x402-aware tooling, not the node we run.
- The Payment Service routes under `/api/v1/x402/*` are an EVM rail (Base mainnet and Sepolia, USDC). They are not Cardano.
- `pip-masumi` has no x402 methods.

PLAN.md's fallback (move USDC on Solana, and only hash the decision into a Masumi job) fails the hackathon rule that agent-to-agent payments themselves go through Masumi. It is not the fallback.

**Rule.** Capital moves with Cardano x402 `exact` and `assetTransferMethod: "default"`, in USDCx on mainnet and tUSDM on Preprod. A small Node service, `facilitator/`, wraps `@x402/cardano`. Python calls it over HTTP. It returns the Cardano tx id after one confirmation. The escrow variant of x402 is forbidden for capital.

**Fallback, only if the facilitator is not signing on demo day.** `POST /api/v1/wallet/transfer-funds` on the Payment Service, from the same hot wallets, admin key, minimum 2 ADA plus the token. The audit labels these rows `plain_transfer`. They are Masumi-operated wallets and ordinary Cardano transactions. They are not escrow payments and the UI must not call them that.

**Cost that replaces "0.17 ADA".** A native-token output needs about 1.17 ADA of min-UTxO beside the stablecoin (`min_lovelace_post_alonzo` on a USDCx output is about 1.168 ADA). That ADA arrives at the recipient and comes back when they spend the output. It is float, not a fee. Budget about 1.4 ADA per outbound stablecoin payment (0.17 fee + 1.17 float). The Payment Service transfer endpoint additionally refuses under 2 ADA of lovelace.

## D4 — What escrow is for

**Corrected.** PLAN.md said escrow jobs (MIP-003) are for the gateway and for reports, that a job costs about 1.8 ADA plus 5%, and that the 5% applies only to the service fee, never to capital. The split between capital and services is the right idea. The fee numbers are not, and the 5% promise is not a property of the protocol.

Checked in the payment service:

- Docs say Masumi charges 5% of the selling price, in the active stablecoin, paid by the seller on collection.
- `FEE_PERMILLE_* = 50` applies to the legacy V1 contract (`Web3CardanoV1`). The V2 validator README says protocol fee payment is not enforced. `prisma/seed.ts` writes `feeRatePermille: 0` for V2 on Preprod and Mainnet. V2 is the default. V1 is seeded only with `SEED_V1_LEGACY=true`.
- There is no "1.8 ADA per job" constant. A completed job is three Plutus transactions: buyer lock, seller submit-result, seller withdraw. Each pays a normal script-transaction fee. A token lock also tops up `MIN_COLLATERAL_LOVELACE` (1,435,230 lovelace), returned to the buyer on withdraw.
- If the fee is turned back on, it is a percentage of the payment price. Putting capital in that price would skim capital. "5% never touches capital" is true only because we never put capital in the price.

Timing, from `POST /payment`:

- `submitResultTime` at least 15 minutes from now.
- `unlockTime` at least 15 minutes after `submitResultTime`.
- `externalDisputeUnlockTime` at least 15 minutes after `unlockTime`.
- The shortest legal cycle is about 45 minutes from request until the seller can withdraw, plus confirmations and the collection cron.
- `pip-masumi` 1.2.0 ignores this and sends `payByTime = now+12h`, `submitResultTime = now+24h`. It also sends `paymentType: "Web3CardanoV1"`, which the service schema no longer accepts (the field is stripped). Its default `identifier_from_purchaser` is the string `default_purchaser_id`, which fails the 14–26 hex-character check.

`FundsLocked` means the buyer has committed the service fee. It does not mean the seller has the money. The seller withdraws only after `unlockTime`, or earlier only through the refund and authorize-withdrawal path, which is the wrong tool for a payout.

**Rule.** MIP-003 escrow on the V2 contract is only for services: the gateway's flat fee, a trader's `report`, and the allocation record that anchors the audit hash. The price is that fee, a few dollars at most, never the trading capital. Deadlines are the API minimums, set by our own REST client, not by the SDK defaults. The buyer starts the real work at `FundsLocked`. The seller collects about 45 minutes later. List and count calls always pass `filterPaymentSourceType=Web3CardanoV2` or the V2 contract address. Registry and payment list endpoints default to V1, and V2 rows are invisible without the filter.

**Poll intervals.** `.env.example` ships `CHECK_TX_INTERVAL` 180s, `BATCH_PAYMENT_INTERVAL` 240s, and 20 confirmations. Code defaults are 20s, 30s, and 1 confirmation. We set the fast values. Copied example values make every payment look stuck for 5–10 minutes.

## D5 — What the gateway is

**Kept, and narrowed.** The gateway moves stablecoin between its own Cardano inventory and its own Solana inventory. Traders swap on Jupiter themselves. One escrow job per swap would still be a bad idea even though the 1.8 ADA figure is not real: three script transactions and a 45 minute unlock around every fill would dominate a $100 book.

**Rule.** Two MIP-003 jobs, `deposit_to_solana` and `withdraw_to_cardano`. The job price is the flat service fee. The capital arrives separately, as an x402 payment whose tx id is in the job input, and the gateway sends the other chain only after that payment has one confirmation. `/availability` returns `unavailable` when inventory is under the low-water mark or the daily cap is spent, and it does that before a buyer can lock a payment. The gateway never calls Jupiter. Top-ups are manual. Per-job and per-day caps are in code.

The service-fee escrow uses the MIP-003 refund path (`request-refund`, `authorize-refund`). The capital refund, if the gateway does not deliver by its deadline, is a second x402 payment back to the sender. Direct x402 has no contract refund.

## D6 — Who signs swaps

**Kept.** Each trader signs Jupiter swaps with its own Solana key. Limits in [ARCHITECTURE.md](ARCHITECTURE.md) are checked in the trader process before the signature, and again by the fund runtime before it asks.

**Rule.** The monitor never holds a Solana key. The gateway holds a Solana key only to send USDC. A Jupiter transaction is signed with `solders` by filling the taker signature and keeping any signature Jupiter already put on the message. Replacing the whole signature list breaks JupiterZ routes (`/execute` code −1003), and those routes are often the best price on WETH, cbBTC, and several xStocks.

## D7 — Who sets allocation

**Corrected.** PLAN.md said a formula proposes, agents may object, and the lead's LLM may adjust weights inside the caps. That fights the formula, and it fights the paper. In HedgeAgents the fund manager is not one of the traders. A trader who can edit the weights will argue for itself. The phase 2 demo ("three rounds, a strong agent gains share and gives it back") is also impossible under the written caps: a 10 point maximum move plus a 2-round cooldown on the same agent cannot show a visible rise and a give-back in three 30-minute rounds.

**Rule.** The allocator is deterministic code in the fund runtime. It is not a trader and it has no LLM. Each trader may submit an objection string. Code applies the objection only when it names a rule the code can recompute: cap, cooldown, kill switch, or daily-loss stop. An objection cannot increase the objecting agent's weight. Every objection is stored, including the ones code ignores.

Weights after a score:

- Each agent stays between 10% and 50% of the fund.
- Sum of weights is 100%.
- No move smaller than 5 points.
- Maximum step is 20 points per round in the demo, 10 points when we slow the cadence down.
- An agent that sent budget waits one round before it can send again. Cooldown does not apply to receiving, and it is not two rounds.
- If every score is near zero, weights do not change.

The demo cadence is 30 minutes, and only after a minimum number of valuation snapshots so the first hour does not churn. A slower cadence uses the 10 point step. Section 6 of PLAN.md is this rule, not the earlier 10-point-and-two-round version.

The one-minute pitch plays this same rule on a paper tape, including one scripted headline that enters the daily-loss path. It does not add a meeting in which agents set weights. The tape is specified under Demo replay below and in section 15 of the architecture.

## D8 — Agent stack

**Corrected.** Python stays. `pip install masumi` (1.2.0) is a FastAPI shell for MIP-003 (`create_masumi_app`, `MasumiAgentServer`) and a thin client (`Payment` for selling, `Purchase` for buying). It is not the Cardano wallet, not the registry client, and not x402. Buyer support exists (`Purchase.create_purchase_request` posts to `/purchase/`) but the deadlines are the 12h/24h defaults above.

`ai-hedge-fund` is a reference, not a dependency. The layout the first draft of this plan pointed at (`src/agents`, `backend/`, `app/`, LangGraph) was deleted on 2 Aug 2026. v2.5.0 is a `hedge_fund/` package: a hash-chained ledger in `paper/ledger.py`, hard limits in `risk/limits.py` (`max_position_pct`, `max_gross_exposure`, enforced in code and recorded as clamp events), and five fundamentals-only personas. There is no crypto, no live broker, and no technicals agent in v2. The technicals agent exists only in the deleted v1 tree. We copy the ledger shape, the clamp-event idea, and abstain-on-LLM-failure. We do not import the package. Financial Datasets has no free tier and is not required.

**Rule.** Python 3.11 for the traders, the gateway, the fund runtime, and the monitor. The Masumi SDK is used to serve MIP-003. Payment creation, short deadlines, and registry reads go through a small REST client we own. Cardano mnemonics live in one local env file consumed by the Payment Service and the facilitator. Solana keys live only in the trader and gateway processes. Nothing secret is placed in a prompt or a log line.

## Added decisions

### One operator, one fund

**Added.** The web app has no accounts. Mutating routes (kill switch, policy confirm, chat that writes a policy) require a single operator token. Read routes on a demo network can be open. There is no second user and no second fund in this build.

### Long only, spot only

**Added.** Traders buy and sell the allowlisted token against USDC. They do not short, and they do not trade options, futures, or perps. The paper's extreme-market conference hedges with puts and a short futures clip. Those venues are not in this system. The implementable version is: a daily loss stop sells the agent toward USDC and blocks it from receiving budget.

### Kill switch

**Added.** One authenticated monitor route sets a row. Every process that can sign reads that row at the start of a tick and refuses to sign if it is set. Trading and allocation stop. Getting cash back to the operator is a manual withdrawal, not an automatic unwind. Unsetting the switch is a second authenticated action.

### Chat writes policy, never a transaction

**Added.** A chat instruction ("cap stocks at 20%", "pause ETH", "less risk") asks the monitor's LLM for a policy diff. The operator sees the current policy and the proposed one and confirms. Confirmation stores a new policy version with a hash. Agents read the latest version on the next tick. A question ("why did BTC get more?") is answered from the database. The chat path has no key and no payment-service admin token.

### Audit hash chain, anchored on Masumi

**Added.** `events` in Postgres is append-only. Each row stores `prev_hash` and `hash = sha256` of the canonical JSON without the hash field. A writer that would break the link fails the insert. The database is not the audit by itself, because anyone with the database can rewrite it. The fund runtime periodically submits a `report` job whose result string contains the current head hash. Masumi writes that string's hash into the escrow datum as `result_hash`. The audit page links the job and shows the head it anchored.

### Valuation

**Added.** Position value uses Jupiter Price v3 `usdPrice`. xStocks and PAXG are Token-2022 with a scaled-UI multiplier (SPYx was 1.003909 on the check day). Value is raw amount times that multiplier times `usdPrice`, divided by `10^decimals`. Using the raw amount alone is wrong by about the multiplier and will not match the wallet UI. ADA and SOL held for fees are not trading PnL. They are a fee line, converted at a spot ADA/USD and SOL/USD from the same price API (or CoinGecko if the mint is not listed). Min-UTxO ADA that rides with a token output is float, not a loss.

Price v3 also returns `stockData.price` for xStocks. Premium versus the underlying is `usdPrice / stockData.price - 1`. Weekend xStock prices are a secondary-market quote. The US cash close is not the fair value on Saturday. Pyth has `Crypto.SPYX/SPY.RR` and the same pattern for the other xStocks, plus `Metal.XAU/USD` for gold. Hermes required a key on the check day (`401`). Jupiter is the mark. Pyth is optional once a key exists.

### xStocks and US persons

**Added.** xStocks are not offered to US persons, or to the UK, Canada, Australia, or sanctioned jurisdictions (xstocks.fi and Kraken's xStocks FAQ). DEX swaps do not check citizenship. The chain filling an order is not permission to buy. Whoever runs the mainnet demo has to be allowed to hold xStocks. This is a constraint on the operator, not a transfer hook we can code around. On the check day the tokens were not paused and the transfer hook program was unset, so a freeze or a hook attached later is an issuer action we cannot prevent. PAXG has the same class of admin keys. cbBTC and USDC can be frozen. WETH does not have a freeze authority.

### Hydra

**Added, out of scope.** Masumi's Payment Service can run Hydra heads (hydra-node 2.4.1, milestone report Sep 2026, sub-second payments inside a head). A head is a 2-party channel: both sides run a host, open a public port, and keep about 30 ADA on the node. It is not a shared network we can join for the hackathon. We do not set `forceLayer: "Hydra"`.

### Sokosumi

**Added, out of scope.** The marketplace can list a registered agent. Agent-to-agent payments in this system do not go through it. We do not block the build on a listing.

### Demo replay, then the live fund

**Added.** The stage pitch is one minute. The fund is long-running: allocation rounds are 30 minutes, an x402 send is one Cardano block, and a fee escrow unlocks in about 45 minutes. A few hours of live returns are noise. Squashing two or three months of mainnet fills into 60 seconds is not possible, and those fills do not exist yet. The pitch still has to show weights moving, profit moving, a history that matches those numbers, and one news shock that forces an emergency round.

What we will not do:

- Play live chain time faster. Cardano and Solana do not confirm months of transactions in a minute.
- Treat a Binance backtest as Masumi history. Paper trades must not be written into `events` or into a `report` job. A judge who recomputes `result_hash` would be checking fills that never settled.
- Seed the live book with the replay profit. After the switch, live history starts at the first real deposit. An empty live fund shows the empty state.
- Let the shock be a strategy meeting. D7 still holds. Agents do not leave the round with weights the formula did not compute.

**Rule.** Two modes, one UI, two ledgers. Section 15 of the architecture is the build spec.

- **Replay.** An offline run of the fund runtime, chain clients stubbed, over about 2–3 months of bars. BTC and ETH are Binance public spot klines (`BTCUSDT`, `ETHUSDT`, 30-minute). The stock sleeve uses a free daily S&P 500 OHLC series. Binance has no spot S&P. The sim steps the real score, caps, buffer, and limits, and stores every paper trade. Profile value at a frame recomputes from that trade list and the bar at that time. Playback is about 60 seconds: about 8–12 allocation frames plus one shock, with the value interpolated between frames. The player does not recompute weights and does not call an LLM.
- **Shock.** One headline is authored onto the tape. A free news aggregate is the wrong source for that sentence: it will not line up "a $50B BTC liquidation" or "a war started" with this window, and a $50B liquidation is not a historical print we should pretend we replayed. The headline starts the daily-loss path for the named agent: sell toward cash, block incoming budget. Objections are collected and applied only when code recomputes the same rule.
- **Live.** The same pages call the live routes as soon as the operator switches. No redeploy. Jupiter stays the mark and the fill. Masumi stays the payment rail. Binance klines, the S&P series, and a free headline feed update in the background and may change conviction on a later tick. A headline mapped to the emergency tag is the only way news starts an allocation round, and it starts the daily-loss path, not a new weight. Gold stays in the live fund. Gold is absent from the tape because we do not have a matching free series in this pass.
- **PLAN.md section 10** stays the live walkthrough (deposit, x402, explorer links, chat cap). It is what we show when someone asks for a real transaction. It is not the one-minute pitch.

## Inconsistencies the rules above close

These are the places PLAN.md disagreed with itself or with the protocol. They are recorded here so a later edit does not reintroduce them.

1. **Capital latency was two different numbers.** D3 said about 20 seconds. Section 4 said Masumi detects payments in 1–7 minutes and a full move takes 10–20 minutes. The 20 seconds is x402 plus one block, if we do not copy the slow `.env.example` poll. The 1–7 minutes is the payment-service poller on the example intervals. The 45 minutes is the escrow unlock floor. A full rebalance that still withdraws through the gateway and swaps twice is minutes of x402 and Jupiter, not an escrow cycle. Escrow sits beside that, on the fee only.
2. **The 5% line and the capital line described the same payment.** D4 said the 5% never hits capital. Section 4's deposit flow put the capital amount in an escrow job. Those cannot both be true if the fee is a percentage of the job price. Capital is the x402 payment. The job price is the fee.
3. **"1.8 ADA plus 5%" was the reason not to escrow every trade.** The reason survives (latency and three script transactions). The figure does not. D5's wording in PLAN.md is updated so nobody goes looking for a constant that is not in the repo.
4. **Phase 2's done-when contradicted section 6.** Three rounds cannot show a gain and a give-back under a 10 point cap and a 2-round cooldown. The cap and the cooldown are changed in D7. The done-when stays.
5. **The lead was a trader and the judge.** D7 removes the LLM adjustment. "Any trader can be lead" in the sense of "the user's deposit lands on one Cardano address, and that agent is just another sleeve" can stay. That address is not allowed to rewrite weights.
6. **`accept_budget` as an escrow job added a 45 minute confirmation to a transfer the chain already showed.** Confirmation of a budget move is the x402 tx id. There is no `accept_budget` job.
7. **Preprod $1 of Solana USDC cannot match a tUSDM balance.** Phase 1's PnL identity check is mainnet only. Preprod is done when the protocol steps complete, not when the numbers match across chains.
8. **Phase 0 asked for upstream docker-compose.** `masumi-payment-service` has a Dockerfile and no compose file. We write `infra/docker-compose.yml`.
9. **The hash chain was described as the audit.** A chain inside Postgres is a tamper-evident log for us. The Masumi `result_hash` anchor is what a judge can check without trusting the database.
10. **Buy-and-hold was undefined for two modes.** Mode 1 marks the token amount the deposit would have bought at arrival, forever. Mode 2's dashed line grows the starting weights by each agent's own return and never applies later transfers. Both definitions are in the architecture so the UI cannot invent a third.
11. **SDK registration of agents was implied.** `pip-masumi` cannot register. Registration is `POST /registry` on the Payment Service (or the admin UI). The selling wallet needs ADA and, on V2, a collateral UTxO of at least 5 ADA. `apiBaseUrl` is not probed at registration time. Buyers and the registry indexer do call it, so a judge who opens the registry from outside needs a tunnel. Our own agents call each other on the Docker network either way.
12. **UTxO contention was omitted.** One hot wallet, one in-flight Cardano transaction. A second send built on a stale UTxO fails. Allocation sends are serialized per wallet. Wallets can be pre-split into several UTxOs so a later tick is not stuck behind a single output.
13. **Stocks were blocked on a paid fundamentals API.** The v2 personas need filings, not a price. Our stocks trader uses the same price, volatility, and drawdown loop as the others, plus an optional headline. No Financial Datasets key.
14. **The one-minute pitch was going to be sped-up live trading.** PLAN.md section 10 is a live walkthrough of about three minutes, and it cannot show months of allocation. The pitch is a paper replay of the allocator. The live walkthrough stays for a real transaction. Replay rows do not enter the hash chain.

## What we will not revisit during the hackathon

Hydra, Sokosumi, a live xReserve hop inside a trade, V1 contracts, USDM (Masumi's previous mainnet stablecoin), Wanchain, shorting, a multi-user auth model, and an agent meeting that sets weights. If a demo-day failure forces the D3 fallback, we use `transfer-funds` and label it honestly.
