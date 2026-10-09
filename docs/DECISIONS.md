# Decisions

Status of every decision in [PLAN.md](../PLAN.md), checked against Masumi, Cardano, Jupiter, and Solana as of 8 October 2026. The rule under each item is what we build. [ARCHITECTURE.md](ARCHITECTURE.md) is the system that follows from these rules.

Sources for the Masumi checks: `masumi-payment-service` at `d569a33` (6 Oct 2026), `pip-masumi` 1.2.0, `@x402/cardano` 2.28.0, and the masumi.network docs fetched the same day. Token mints and Jupiter quotes were read live the same day. `virattt/ai-hedge-fund` was read at v2.5.0 (`78b779c`, 2 Oct 2026) and at the last v1 tag (`v2026.7.10`).

Design-review corrections dated 9 October 2026 cover settlement recovery, accounting, allocation, signer ownership, abstention, refunds, and the V2 request contract. Market/liquidity figures remain the 8 October observations, not newly executed trades. Non-atomic Cardano-Solana settlement is an accepted constraint. Required implementation tests are in architecture section 16; this decision log is not evidence that those tests have run.

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

**Rule.** Cardano budget moves use x402 `exact` and `assetTransferMethod: "default"`, in USDCx on mainnet and tUSDM on Preprod. A small Node facilitator wraps `@x402/cardano`, authenticates each caller, and owns capital wallets exclusively. It persists an intent, signed attempt, tx id, and input reservation before broadcast. A response distinguishes confirmed from pending/unknown and always retains the original intent and tx id. A 75-second timeout does not authorize a replacement payment. The escrow variant of x402 is forbidden for capital.

**Fallback, only after exclusive ownership handoff.** Halt new capital operations, stop the facilitator, and reconcile every outstanding attempt before importing capital wallets into the Payment Service as purchasing-only wallets. Then an operator may use `POST /api/v1/wallet/transfer-funds`, admin key, minimum 2 ADA plus the token. An unresolved old attempt blocks handoff. Switching back disables those imported wallets and resolves the queue before restarting the facilitator. Rows are `plain_transfer`: ordinary Cardano payments through Masumi-operated wallets, not escrow. Normal operation never loads the same active wallet into both signers.

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
- Normal uncontested unlock is therefore at least about 30 minutes from request, plus confirmations and collection scheduling. The roughly 45-minute minimum belongs to external dispute unlock, not normal seller collection.
- `payByTime` must be at least 5 minutes before `submitResultTime`; our client uses a future pay-by. From a single request clock, defaults are +5/+16/+31/+46 minutes respectively, with a one-minute validation buffer. Reject clock skew or an exhausted buffer before funding; do not mutate the terms of an already-created job.
- `pip-masumi` 1.2.0 ignores this and sends `payByTime = now+12h`, `submitResultTime = now+24h`. It also sends `paymentType: "Web3CardanoV1"`, which the service schema no longer accepts (the field is stripped). Its default `identifier_from_purchaser` is the string `default_purchaser_id`, which fails the 14–26 hex-character check.

`FundsLocked` means the buyer has committed the service fee. It does not mean the seller has the money. The seller withdraws only after `unlockTime`, or earlier only through the refund and authorize-withdrawal path, which is the wrong tool for a payout.

**Required V2 selector.** `POST /payment` must send `supportedPaymentSourceIndex` resolved from the seller's advertised payment sources. Verify that selection's chain, network, V2 settlement address, and asset unit. The agent identifier and script address do not replace the index. Persist it with the returned blockchain identifier and deadlines; purchase creation reuses those returned terms. The [pinned creation handler](https://github.com/masumi-network/masumi-payment-service/blob/d569a338ca54d5be7441564770d75ebf89b71f12/src/routes/api/payments/index.ts) rejects missing V2 selection and enforces the timing intervals above. [Normal collection](https://www.masumi.network/dev/masumi/core-concepts/payments) follows `unlockTime`, not `externalDisputeUnlockTime`.

**Rule.** MIP-003 V2 escrow is only for service fees: gateway work and a trader's `report`, including the allocation audit anchor. An on-chain anchor uses a positive fee; a free report is not an on-chain anchor. Our REST client supplies explicit buffered deadlines and the V2 index, not SDK defaults. Work begins only when the fee is `FundsLocked` and its other prerequisites hold. Collection normally becomes eligible at our +31-minute unlock. List/count calls filter `Web3CardanoV2` or the V2 address so defaults cannot hide V2 rows.

Job identity, purchaser nonce, terms, progress, and exact output are durable. Repeated starts return the same job. A lost creation response is reconciled before retrying creation; ambiguity blocks funding. A lost result-submission response retries only the commitment, not the money movement. No fee is both paid in escrow and subtracted from principal. Locking is a prepaid asset; delivery recognizes the fee once, and later collection does not charge it again (architecture section 10).

**Poll intervals.** `.env.example` ships `CHECK_TX_INTERVAL` 180s, `BATCH_PAYMENT_INTERVAL` 240s, and 20 confirmations. Code defaults are 20s, 30s, and 1 confirmation. We set the fast values. Copied example values make every payment look stuck for 5–10 minutes.

## D5 — What the gateway is

**Kept, with an explicit recovery contract.** The gateway exchanges stablecoin using pre-funded inventory on two chains. It does not provide atomic delivery, run a bridge, extend credit, or call Jupiter. Escrow remains beside the principal movement on the flat fee only; a roughly 30-minute normal unlock is still unsuitable around every trade.

**Rule.** `POST /transfers/prepare` reserves destination inventory and daily capacity atomically before creating either `deposit_to_solana` or `withdraw_to_cardano`. The MIP-003 input binds the intent id and immutable terms. Lock the separate fee first; only then send principal and attach its receipt to the intent. `/availability` is advisory, not a reservation. Active reservations survive midnight and unknown outcomes. Incoming principal stays protected against reuse until payout/refund confirms. Full state transitions and expiry handling are in architecture section 5.

| Direction | Principal received | Successful payout | Principal refund if delivery fails |
|---|---|---|---|
| Deposit to Solana | Cardano x402 USDCx/tUSDM | Full principal in Solana SPL USDC | Cardano x402 to the verified registered source |
| Withdraw to Cardano | Solana SPL USDC | Full principal in Cardano x402 USDCx/tUSDM | Solana SPL USDC to the verified registered source |

Verify the chain/environment, successful confirmation, actual amount, asset, source ownership, and exact gateway destination. Exclusively claim each `(environment, chain, tx_id, transfer_locator)` once, including after refund. A receipt or job retry returns the original outcome, not a second payout. Mutable destination fields and a tx id alone are not proof. Direct transfers have no contract-level capital refund; the separate service-fee refund uses `request-refund` / `authorize-refund`.

Persist signed attempts before broadcast and reconcile them on restart. A deadline or missing RPC lookup is not failure evidence: no refund or replacement is allowed while a payout may still land. Proven failed/expired attempts can transition to a single same-chain refund; unavailable history remains `manual_review`. Late inbound capital is reconciled and either fulfills a still-admitted intent or is returned. One Cardano confirmation is an accepted demo rollback risk; rollback freezes the affected operation for review, not an automatic duplicate send.

## D6 — Who signs swaps

**Kept.** Each trader signs Jupiter swaps with its own Solana key. Limits in [ARCHITECTURE.md](ARCHITECTURE.md) are checked in the trader process before the signature, and again by the fund runtime before it asks.

**Rule.** The monitor never holds a Solana key. The gateway holds a Solana key only to send USDC. A Jupiter transaction is signed with `solders` by filling the taker signature and keeping any signature Jupiter already put on the message. Replacing the whole signature list breaks JupiterZ routes (`/execute` code −1003), and those routes are often the best price on WETH, cbBTC, and several xStocks.

Each Solana wallet has one durable unresolved attempt across swaps and transfers. Record signed bytes, signature, request id, and validity before execute. A timeout is reconciled by the original signature; a new quote is allowed only after confirmed failure or proven non-landing expiry. Immediately re-check the kill switch, active policy, fresh marks, balances, and limits before signing. Model failure is a terminal hold with null conviction and the current position, not conviction zero passed through the target formula.

## D7 — Who sets allocation

**Corrected.** PLAN.md said a formula proposes, agents may object, and the lead's LLM may adjust weights inside the caps. That fights the formula, and it fights the paper. In HedgeAgents the fund manager is not one of the traders. A trader who can edit the weights will argue for itself. The phase 2 demo ("three rounds, a strong agent gains share and gives it back") is also impossible under the written caps: a 10 point maximum move plus a 2-round cooldown on the same agent cannot show a visible rise and a give-back in three 30-minute rounds.

**Rule.** The allocator is deterministic code in the fund runtime. It is not a trader and it has no LLM. Each trader may submit an objection string. Code applies the objection only when it names a rule the code can recompute: cap, cooldown, kill switch, or daily-loss stop. An objection cannot increase the objecting agent's weight. Every objection is stored, including the ones code ignores.

Score decayed net unit-NAV returns divided by their volatility, not changes in raw wallet value. Contributions and internal transfers change ownership units, not return. Architecture section 7 defines the interval, decay, floors, and deterministic bounded-simplex projection; there is no clip-and-renormalize fallback.

- Mode 2 targets sum to 100%, with 10% floors and caps no higher than 50%. Confirmed custom caps must be jointly feasible. Mode 1's single 100% sleeve bypasses this allocator; two Mode 2 sleeves necessarily stay at 50/50, so adaptive demos need at least three.
- Bootstrap allocates contributions without a performance history or movement limits. Ordinary performance rounds wait for at least one hour of valid NAV history and the previous round to resolve.
- Ordinary changed weights move at least 5 points and at most 20 in the demo, 10 at daily cadence. A sender waits one completed round before sending again. Paused weights freeze; stopped and zero-score sleeves cannot receive.
- Hard-bound repair takes precedence over minimum move, maximum step, sender cooldown, and discretionary pause freezing. Lowering a 50% sleeve's cap to 20% can therefore cause a logged 30-point repair. A pause still forbids discretionary token buys. Kill/stale-data guards and the no-receive daily stop remain binding.
- Impossible policies are rejected with 422. A later infeasible round is blocked and visible, not normalized into a false solution. All-zero scores hold only when no hard repair is needed.
- Freeze the policy version and input snapshots for a round. Persist its ordered legs before sends, resume confirmed/partial work idempotently, and distinguish target from settled weights. Do not start a new performance round while one is unresolved.

The demo cadence remains 30 minutes. An offline three-round fixture must show a gain and give-back; three live rounds may correctly hold if actual performance does not justify movement. Never alter a live score to force the fixture's market outcome. An ordinary emergency round moves budget within the normal step limit while de-risking remaining exposure to cash; hard-bound repair is a separate, logged exception.

The one-minute pitch plays this same rule on a paper tape. Its score is a handwritten series, and a large drop enters the daily-loss path. It does not add a meeting in which agents set weights. The series is specified under Demo replay below, in section 12 of PLAN.md, and in section 15 of the architecture.

## D8 — Agent stack

**Corrected.** Python stays. `pip install masumi` (1.2.0) is a FastAPI shell for MIP-003 (`create_masumi_app`, `MasumiAgentServer`) and a thin client (`Payment` for selling, `Purchase` for buying). It is not the Cardano wallet, not the registry client, and not x402. Buyer support exists (`Purchase.create_purchase_request` posts to `/purchase/`) but the deadlines are the 12h/24h defaults above.

`ai-hedge-fund` is a reference, not a dependency. The layout the first draft of this plan pointed at (`src/agents`, `backend/`, `app/`, LangGraph) was deleted on 2 Aug 2026. v2.5.0 is a `hedge_fund/` package: a hash-chained ledger in `paper/ledger.py`, hard limits in `risk/limits.py` (`max_position_pct`, `max_gross_exposure`, enforced in code and recorded as clamp events), and five fundamentals-only personas. There is no crypto, no live broker, and no technicals agent in v2. The technicals agent exists only in the deleted v1 tree. We copy the ledger shape, the clamp-event idea, and abstain-on-LLM-failure. We do not import the package. Financial Datasets has no free tier and is not required.

**Rule.** Python 3.11 for traders, gateway, runtime, and monitor. The Masumi SDK serves MIP-003; our REST client handles V2 selection, buffered deadlines, and registry reads. Postgres owns durable job and transaction state. Each agent has distinct Cardano capital, purchasing, and selling keys: the facilitator alone gets capital keys, and the Payment Service alone gets fee-wallet keys. Compose injects only service-specific env entries. Trader/gateway API credentials are scoped to their own wallets, never admin credentials. Solana keys live only in their signer processes. Nothing secret or signed-but-unbroadcast is placed in a prompt or public log.

## Added decisions

### One operator, one fund

**Added.** The web app has no accounts. Mutating routes (kill switch, policy confirm, chat that writes a policy) require a single operator token. Read routes on a demo network can be open. There is no second user and no second fund in this build.

### Long only, spot only

**Added.** Traders buy and sell the allowlisted token against USDC. They do not short, and they do not trade options, futures, or perps. The paper's extreme-market conference hedges with puts and a short futures clip. Those venues are not in this system. The implementable version is: a daily loss stop sells the agent toward USDC and blocks it from receiving budget.

### Kill switch

**Added.** An authenticated row stops new swaps, allocation sends, and gateway admissions. Check at admission and again immediately before signing; inaccessible controls fail closed. The switch does not undo broadcasts. Reconciliation, fee collection/refunds, and settlement or same-chain refund of already-confirmed inbound capital continue under their existing terms. Unfunded intents cancel/refund fees. Positions are not automatically sold; an operator cash-out is explicit and never silently clears the switch. Unsetting it is a separate authenticated action.

### Chat writes policy, never a transaction

**Added.** Chat proposes a policy diff or answers from the database. Confirmation includes the expected latest confirmed version (409 on a stale edit), validates feasible hard bounds (422 if impossible), and stores a pending version with a hash. The runtime activates it at the next round boundary and pins it for that round and subsequent ticks; agents do not independently adopt the highest pending version. The UI distinguishes pending, active, and achieved weights. Mode 1 uses the same activation clock without Mode 2 weight controls. Chat has no chain key or payment-service admin token.

### Audit hash chain, anchored on Masumi

**Added.** `events` in Postgres is append-only. Each row stores `prev_hash` and `hash = sha256` of the canonical JSON without the hash field. A writer that would break the link fails the insert. The database is not the audit by itself, because anyone with the database can rewrite it. The fund runtime periodically submits a `report` job whose result string contains the current head hash. Masumi writes that string's hash into the escrow datum as `result_hash`. The audit page links the job and shows the head it anchored.

### Valuation

**Added.** Position value uses Jupiter Price v3 `usdPrice`. xStocks and PAXG are Token-2022 with a scaled-UI multiplier (SPYx was 1.003909 on the check day). Value is raw amount times that multiplier times `usdPrice`, divided by `10^decimals`. Amounts are raw integers and USD arithmetic is decimal. Require fresh reconciled marks; missing data blocks new risk rather than fabricating a return.

Fund equity includes trader capital, purchasing stablecoin reserves, marked Solana assets, principal receivables, and fee prepayments, less expense payables. Gateway inventory and selling revenue are outside the fund, even with the same operator. Own-chain conversions replace liquid principal with a claim and back, without changing ownership. Trader fee-reserve contributions are capital flows, not profit. ADA/SOL operating float, min-UTxO, and refundable rent are outside trading assets; actual fund-paid network fees create an expense payable once, and repayment is not a second expense.

```text
net_pnl = equity_end - equity_start - contributions + distributions
gross_pnl = net_pnl + recognized_costs
```

At sleeve scope, contributions/distributions include internal budget moves; at fund scope those cancel. Locking an escrow fee creates a prepaid/refundable asset; delivery consumes it once and seller collection adds no expense. A failed job's fee refund restores cash, or reverses an expense already recognized. Execution cost uses confirmed net token amounts at common-time marks, is already inside equity, and is not debited again. Quote `inUsdValue`/`outUsdValue` are estimates. Thus a 100-to-99 swap with a 1 USD cost has net -1 and gross 0, not net -2.

Flow-adjusted ownership units are issued/redeemed at pre-flow NAV; fees and trading change NAV, not unit count. Scores, volatility, drawdown, daily stops, and the constant-allocation benchmark use that unit return series. Sending 20 from a 100 USD sleeve without costs leaves 80 equity/80 units at NAV 1, not a 20% loss. Missing UTC-open history blocks new buys until reconstructed. Daily stops latch through the UTC day and de-risk through code, independent of the LLM, without overriding the kill switch. Architecture sections 8 and 10 define withdrawal-adjusted benchmarks and fee attribution.

Price v3 also returns `stockData.price` for xStocks. Premium versus the underlying is `usdPrice / stockData.price - 1`. Weekend xStock prices are a secondary-market quote. The US cash close is not the fair value on Saturday. Pyth has `Crypto.SPYX/SPY.RR` and the same pattern for the other xStocks, plus `Metal.XAU/USD` for gold. Hermes required a key on the check day (`401`). Jupiter is the mark. Pyth is optional once a key exists.

### xStocks and US persons

**Added.** xStocks are not offered to US persons, or to the UK, Canada, Australia, or sanctioned jurisdictions (xstocks.fi and Kraken's xStocks FAQ). DEX swaps do not check citizenship. The chain filling an order is not permission to buy. Whoever runs the mainnet demo has to be allowed to hold xStocks. This is a constraint on the operator, not a transfer hook we can code around. On the check day the tokens were not paused and the transfer hook program was unset, so a freeze or a hook attached later is an issuer action we cannot prevent. PAXG has the same class of admin keys. cbBTC and USDC can be frozen. WETH does not have a freeze authority.

### Hydra

**Added, out of scope.** Masumi's Payment Service can run Hydra heads (hydra-node 2.4.1, milestone report Sep 2026, sub-second payments inside a head). A head is a 2-party channel: both sides run a host, open a public port, and keep about 30 ADA on the node. It is not a shared network we can join for the hackathon. We do not set `forceLayer: "Hydra"`.

### Sokosumi

**Added, out of scope.** The marketplace can list a registered agent. Agent-to-agent payments in this system do not go through it. We do not block the build on a listing.

### Demo replay, then the live fund

**Added.** The stage pitch is one minute. Live allocation rounds are 30 minutes; an x402 confirmation is about one Cardano block, and normal escrow unlock is at least about 30 minutes (31 with our buffer). The 45-minute minimum is for external disputes. A few hours of live returns are noise, and months of mainnet fills cannot be compressed into a minute. The pitch uses a paper tape with a handwritten score shock, the same allocation constraints, and reconciled paper trades, not a strategy meeting.

What we will not do:

- Play live chain time faster. Cardano and Solana do not confirm months of transactions in a minute.
- Treat a Binance backtest as Masumi history. Paper trades must not be written into `events` or into a `report` job. A judge who recomputes `result_hash` would be checking fills that never settled.
- Seed the live book with the replay profit. After the switch, live history starts at the first real deposit. An empty live fund shows the empty state.
- Let the shock be a strategy meeting. D7 still holds. Agents do not leave the round with weights the formula did not compute.
- Use the handwritten series as the live score. After the switch, the score is decayed net unit-NAV return divided by its volatility. The pitch must not present `0.40` as that formula on the bars.
- Treat the score as a dial from gold to BTC. Each sleeve has its own score. A high number means that sleeve gets more budget. It does not mean "buy the volatile asset."
- Let one headline set the score. The live score reads flow-adjusted net NAV. An article alone does not alter prices, recognized costs, or the score.

**Rule.** Two modes, one UI, two ledgers. Section 15 of the architecture is the build spec.

- **Replay.** An offline run of the runtime, chain clients stubbed, over about 2-3 months of bars. BTC/ETH use Binance public spot `BTCUSDT`/`ETHUSDT` 30-minute klines; stocks use a free daily S&P 500 OHLC series. Carry the last available stock price between daily prints, not a repeatedly compounded daily return. A handwritten series supplies 8-12 score points per sleeve, for example `[0.80, 0.84, 0.87, 0.40]`. The sim uses the bounded projection, buffer, and limits, stores every paper trade, and derives frame value from trades and prices. Playback reads those rows for about 60 seconds, without calling an LLM or recalculating scores.
- **Shock.** A fall of more than `0.20` from the previous point on one sleeve. `0.87` to `0.40` is the example. Smaller steps only move budget. The series is written so the threshold fires once. That sleeve takes the daily-loss path: sell toward cash, block incoming budget. Its weight falls by at most 20 points in that round. The moved slice can be bought by another sleeve. The rest of the sale stays as cash on the sleeve that dropped. A headline may be shown on that frame as a caption. The caption does not fire the round, and it is not fetched from a news feed. Objections are collected and applied only when code recomputes the same rule.
- **Headline.** A bad article influences the trader's next conviction, inside the position cap, or it influences nothing if the model call fails. It does not change the return-over-volatility score, and it does not move budget. The emergency tag is a separate switch we set. An ordinary headline does not receive it. Example: the caption says "BTC crash" and the BTC price did not fall, so the BTC score stays `0.80`. The sleeve does not sell.
- **Live.** The same pages call live routes after the switch, without redeploying. Jupiter Price v3 supplies marks; confirmed Swap v2 executions supply fills. Masumi stays the payment rail. Binance klines, the S&P series, and headlines may change a later conviction, never the score directly. Only an explicit emergency tag starts the cash-target daily-stop path. Gold stays live but is absent from the tape because this pass has no matching free series.
- **PLAN.md section 10** stays the live walkthrough (deposit, x402, explorer links, chat cap). It is what we show when someone asks for a real transaction. It is not the one-minute pitch.

## Inconsistencies the rules above close

These are the places PLAN.md disagreed with itself or with the protocol. They are recorded here so a later edit does not reintroduce them.

1. **Capital latency and escrow windows were mixed.** An x402 confirmation is about one block; copied example poll intervals can add minutes. Normal escrow unlock has a roughly 30-minute minimum, while external-dispute unlock has a roughly 45-minute minimum. Our defaults add a one-minute validation buffer. Gateway capital waits for a locked fee and confirmed source receipt, not for seller collection.
2. **The 5% line and the capital line described the same payment.** D4 said the 5% never hits capital. Section 4's deposit flow put the capital amount in an escrow job. Those cannot both be true if the fee is a percentage of the job price. Capital is the x402 payment. The job price is the fee.
3. **"1.8 ADA plus 5%" was the reason not to escrow every trade.** The reason survives (latency and three script transactions). The figure does not. D5's wording in PLAN.md is updated so nobody goes looking for a constant that is not in the repo.
4. **The allocation demo and its constraints were not a testable contract.** D7 defines ordinary 20-point/one-round movement rules and separate hard repairs. An offline fixture proves gain and give-back; live rounds may legitimately hold. Two sleeves with 50% caps cannot demonstrate changing weights.
5. **The lead was a trader and the judge.** D7 removes the LLM adjustment. "Any trader can be lead" in the sense of "the user's deposit lands on one Cardano address, and that agent is just another sleeve" can stay. That address is not allowed to rewrite weights.
6. **`accept_budget` added an unnecessary escrow job around confirmed capital.** A verified, deduplicated x402 receipt confirms a budget move. There is no `accept_budget` job and no wait for a seller unlock on principal.
7. **Preprod $1 of Solana USDC cannot match a tUSDM balance.** Phase 1's PnL identity check is mainnet only. Preprod is done when the protocol steps complete, not when the numbers match across chains.
8. **Phase 0 asked for upstream docker-compose.** `masumi-payment-service` has a Dockerfile and no compose file. We write `infra/docker-compose.yml`.
9. **The hash chain was described as the audit.** A chain inside Postgres is a tamper-evident log for us. The Masumi `result_hash` anchor is what a judge can check without trusting the database.
10. **Benchmarks and withdrawals were undefined.** Mode 1 tracks contributed hypothetical token lots and proportional redemptions. Mode 2 holds fixed shadow ownership in actual net unit-NAV series, adjusting only for external contributions/distributions. Remaining value and distributions are compared explicitly; internal transfers do not fabricate returns.
11. **SDK registration of agents was implied.** `pip-masumi` cannot register. Registration is `POST /registry` on the Payment Service (or the admin UI). The selling wallet needs ADA and, on V2, a collateral UTxO of at least 5 ADA. `apiBaseUrl` is not probed at registration time. Buyers and the registry indexer do call it, so a judge who opens the registry from outside needs a tunnel. Our own agents call each other on the Docker network either way.
12. **Runtime serialization did not cover two independent signers.** Capital, purchasing, and selling wallets now have disjoint keys and one active owner. Durable per-wallet attempts prevent a crashed worker from bypassing the queue. UTxO splitting is an optimization, not a lock.
13. **Stocks were blocked on a paid fundamentals API.** The v2 personas need filings, not a price. Our stocks trader uses the same price, volatility, and drawdown loop as the others, plus an optional headline. No Financial Datasets key.
14. **The one-minute pitch was going to be sped-up live trading.** PLAN.md section 10 is a live walkthrough of about three minutes, and it cannot show months of allocation. The pitch is a paper replay. Its score is the handwritten series in PLAN.md section 12. The live walkthrough stays for a real transaction. Replay rows do not enter the hash chain. Live rounds do not read that series.
15. **Gateway timeouts were treated as failure.** Durable receipt claims, inventory reservations, signed attempts, and terminal outcomes distinguish delayed settlement from proven non-delivery. A withdrawal refund returns Solana USDC, not Cardano capital the gateway may not have.
16. **PnL subtracted fees twice and raw balance losses included transfers.** Equity includes pending claims and recognized liabilities; cash flows issue/redeem units. Net is the equity identity and gross adds costs back. A neutral conviction is distinct from a failed-model terminal hold.
17. **V2 selection and policy activation were incomplete.** Payment creation requires the advertised source index. Confirmed policies activate only at a pinned runtime boundary; hard bounds outrank ordinary smoothing, and infeasible limits are rejected or visibly blocked.

## What we will not revisit during the hackathon

Hydra, Sokosumi, a live xReserve hop inside a trade, V1 contracts, USDM (Masumi's previous mainnet stablecoin), Wanchain, shorting, a multi-user auth model, and an agent meeting that sets weights. If a demo-day failure forces the D3 fallback, we use `transfer-funds` and label it honestly.
