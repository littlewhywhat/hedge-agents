# HedgeAgents on Masumi — build plan

Agents that trade real tokenized markets for a user, get paid and move budget between each other on Masumi (Cardano), and show every step in a web app.

Inspired by HedgeAgents (arXiv:2502.13165, specialists + budget allocation) and `virattt/ai-hedge-fund` (hash-chained ledger, hard risk limits). Both are references, not dependencies. The hedge-fund repo was rewritten in August 2026; the ledger and the limits we copy are in v2 (`hedge_fund/paper/ledger.py`, `hedge_fund/risk/limits.py`), not the deleted `src/agents` tree.

The spec that implementation follows is:

- [docs/DECISIONS.md](docs/DECISIONS.md) — what changed from the first draft of this file, and why.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — processes, wallets, money, trading, allocation, data, web, failures, phases.

Where this file and those two disagree, the docs win. Design-review corrections were applied on 9 October 2026. Non-atomic Cardano-Solana transfers are accepted; durable recovery is required. The architecture's section 16 defines implementation acceptance tests, not tests already delivered by this documentation-only repository.

## 1. What we're building

**Mode 1 — foundation**
- One **trader agent** trades one market the user picks: tokenized gold, tokenized stocks, ETH, or BTC.
- The user gives it a budget.
- A **gateway agent** connects it to that market. Masumi lives on Cardano; the liquid markets for these tokens live on Solana. The gateway moves money between the two from inventory it already holds. There is no live Cardano–Solana bridge in the trade path.
- Goal: grow the user's budget. Success is measured as net profit after every fee, against simply holding the same asset.

**Mode 2 — team**
- Four trader agents, one per market: gold, stocks, ETH, BTC.
- The user funds one Cardano address with the whole budget. The fund runtime splits it. That address is not allowed to rewrite the weights.
- Each round, code compares performance and moves budget between wallets: more to whoever is earning, back again when that run ends.
- Agent-to-agent **capital** moves as Cardano x402 payments (Masumi's direct payment rail). Service fees and reports are Masumi escrow jobs. Capital is never the escrow price.

**Web app**
- Profile with stats: performance, fees, gross profit, net profit.
- Audit trail of every transaction, with links to the blockchain explorers, and a hash chain whose head is anchored in a Masumi report.
- Mode 2: one chart with each agent's value over time, so you can see where money moved and whether it paid off.
- Chat with the fund to adjust strategy and how budget is split. Chat writes a policy. It does not sign.

One operator, one fund. No accounts.

## 2. Decisions

Checked 8 October 2026. Evidence and the rejected alternatives are in [docs/DECISIONS.md](docs/DECISIONS.md).

| # | Decision | What we build | Why this and not the first draft |
|---|---|---|---|
| D1 | Where trading happens | Solana mainnet via Jupiter Swap v2, for all four markets | Kept. Mints are verified; see section 5. |
| D2 | Networks | Two environments that never mix. **Preprod:** Masumi Preprod, tUSDM, Solana devnet, protocol wiring only. **Mainnet:** Masumi mainnet, USDCx, Solana mainnet, real PnL. | Preprod cannot prove profit. Devnet Jupiter does not have these markets. USDCx is Circle xReserve, live since 27 Feb 2026. |
| D3 | Budget transfers | Cardano x402 `exact`, `assetTransferMethod: "default"` (wallet to wallet), via a small Node facilitator. About one block. No Masumi fee. | The Payment Service and the Python SDK do not expose Cardano x402. Their `/x402` API is Base. The escrow variant of x402 cannot be completed by our payment-service node, so it is forbidden for capital. |
| D4 | Paid services | MIP-003 V2, flat fee only. Normal unlock minimum about 30 minutes, buffered default 31; external-dispute minimum about 45. Our REST client sends the required `supportedPaymentSourceIndex`. | V2 fee rate is 0 today. Capital is never the selling price. SDK deadline defaults are not used; purchase reuses the persisted returned terms. |
| D5 | Gateway role | Reserved inventory exchange with durable `deposit_to_solana` / `withdraw_to_cardano` intents. Verify and claim the confirmed source receipt once before payout. | Non-atomic delivery is accepted. Timeouts require reconciliation, not a duplicate payout or an automatic refund. |
| D6 | Who places trades | Each trader signs its own Jupiter swaps from its own Solana wallet | Kept. Allowlisted mints. Limits in section 8. |
| D7 | Who decides allocation | Deterministic bounded projection of flow-adjusted performance. Hard-cap repair outranks ordinary movement smoothing. Verified objections name rules, never proposed weights. | Clip/renormalize does not enforce all constraints; infeasible policies must be rejected or visibly blocked. |
| D8 | Stack | Python 3.11; Masumi SDK as HTTP shell, Postgres for durable state. Facilitator owns capital keys; Payment Service owns separate purchasing/selling keys. Solana keys stay with their signers. | Neither SDK memory nor scheduler-only serialization is a durable money/recovery contract. |

**Fallback requires exclusive ownership handoff:** halt capital work, stop the facilitator, resolve its attempts, then import capital wallets as purchasing-only Payment Service wallets and use the operator's `POST /wallet/transfer-funds` (minimum 2 ADA plus tokens). Pending attempts block the handoff. Reverse the handoff before restarting the facilitator. Audit these as plain transfers, not escrow. Moving agent budgets on Solana and merely hashing the decisions does not meet the Masumi payment requirement.

## 3. Architecture

The component diagram, wallet layout, and request paths are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version:

```mermaid
flowchart LR
  user([Operator]) -->|browser| web[Web app]
  web --> api[Monitor + Postgres]
  api --> runtime[Fund runtime]

  subgraph Cardano
    pay[Masumi Payment Service]
    fac[x402 facilitator]
  end

  subgraph Agents
    traders[Trader processes x4]
    gw[Gateway]
  end

  subgraph Solana
    jup[Jupiter Swap v2]
  end

  runtime --> traders
  runtime --> gw
  traders --> fac
  gw --> fac
  traders --> pay
  gw --> pay
  traders --> jup
  api -->|reads jobs, balances, prices| pay
  api --> jup
```

**Each trader** has a Masumi registry entry, three distinct Cardano wallets (capital, purchasing, selling), and one Solana wallet. The gateway has the same key-role separation: fifteen Cardano wallets and five Solana wallets in the full configuration. Only purchasing/selling wallets need script collateral; all wallets need role-appropriate fee float. Fund-owned purchasing stablecoin is a separately tracked fee reserve. The runtime schedules new trading/allocations; signers enforce durable per-wallet reservations and re-check limits before signing.

**The gateway** holds USDCx on Cardano and USDC on Solana, funded by us before the demo. Wanchain's Cardano route has been down since the 20 July 2026 exploit. xReserve mint is about 15–25 minutes and the burn back is about 2 hours, so restocking is manual and not part of a trade.

**Payment Service settings that matter:** V2 only, `CHECK_TX_INTERVAL=20`, `BATCH_PAYMENT_INTERVAL=30`, one confirmation. List calls filter `Web3CardanoV2`. Normal operation imports only purchasing/selling keys; capital keys belong exclusively to the facilitator. Every V2 payment selects the advertised `supportedPaymentSourceIndex`. Default request deadlines are +5/+16/+31/+46 minutes for pay-by/result/normal unlock/external dispute unlock, with the returned terms persisted and reused.

## 4. Money flows

### Mode 1

1. **Fund.** The operator sends USDCx to trader capital and funds its purchasing fee reserve. Both external contributions are recorded; internal reserve top-ups are not another deposit. A browser wallet is optional.
2. **Move to Solana.** Prepare a gateway intent and atomically reserve inventory/quota. Open `deposit_to_solana` with its immutable terms and lock the flat fee from the purchasing wallet. Only then x402-send principal from trader capital and attach the persisted tx/output receipt. After verification and exclusive receipt claim, the gateway sends the full USDC principal, without subtracting the escrow fee again. Persist payout confirmation and the job result; seller collection after the normal unlock does not block trading.
3. **Trade.** The trader swaps USDC and its allowlisted token on Jupiter, inside the limits in section 8.
4. **Cash out.** Sell to USDC, reserve `withdraw_to_cardano`, and lock its separate fee. Send SPL USDC to the gateway on Solana, then attach that receipt. After verification the gateway x402-sends USDCx back. Settle outstanding expense payables and x402-pay the remaining distribution to the operator. Solana principal is never described as a Cardano x402 send.

If delivery fails and no original payout can still land, return principal on its original chain: Cardano x402 for a deposit, Solana SPL USDC for a withdrawal. Authorize the MIP-003 fee refund separately. A timeout keeps the original intent and tx id pending/unknown. Reconcile it before any replacement or refund; late inbound capital is never silently abandoned. Architecture section 5 defines the state machine, proof validation, and crash recovery.

### Mode 2 — rebalance round

The initial split uses projected equal weights, without performance movement limits. Later rounds use the Cardano buffer first; only a larger move needs this full path:

1. A giving agent sells part of its position to USDC and withdraws it through a reserved gateway intent.
2. It x402-pays the receiving agent on Cardano. The tx id is the receipt. There is no `accept_budget` escrow job.
3. The receiver deposits through its own reserved gateway intent and buys its token inside local limits.
4. **Buffer:** each agent keeps about 15% of its share as stablecoin on Cardano, so a small move never touches Solana.
5. Persist the round, frozen policy/snapshots, and ordered idempotent legs before sending. Signers permit one unresolved attempt per wallet. Restart resumes remaining legs; no later performance round starts while this one is unresolved. Record target and actual settled weights separately.

### Cost per rebalance (replaces the old 1.8 ADA table)

| Item | Cost |
|---|---|
| x402 stablecoin send | About 0.17 ADA in fees, plus about 1.17 ADA of min-UTxO that arrives with the token and comes back when the recipient spends it. Float, not a burned fee. |
| Wallet reserves | Purchasing/selling wallets each need 5 ADA collateral plus fee float; capital wallets need separate fee/min-UTxO float. Budget by wallet, not just by agent. |
| Gateway escrow, fee only | Three script transactions. No protocol percentage on V2 today. Normal unlock minimum about 30 minutes, default 31; external disputes have a roughly 45-minute minimum. Seller collection is not on the trading critical path. |
| Gateway fee | A flat amount we set, small. Never a percentage of capital inside the escrow price. |
| Jupiter, demo size ($100–500) | Quote estimates about 0.1% (SPYx, WETH, cbBTC) to about 0.3% (PAXG, TSLAx). Realized execution cost uses confirmed net amounts at common-time marks, not a second debit of the quoted gap. |
| Solana | Well under $0.01, plus Jupiter's priority fee on `/execute`. |
| Latency of the money | One Cardano block for the x402, then a Solana confirmation. A full withdraw-pay-deposit-buy is minutes, not an escrow cycle. |

**Consequence:** under about $100 per agent, one Solana round trip dominates the PnL. Use $100–250 per agent on mainnet, and few rebalances. PAXG's Jupiter book is only about $343k, so gold clips stay in the hundreds of dollars.

## 5. Agents

### Trader (one codebase, one config per market)

Mints checked on Jupiter on 8 Oct 2026. Full table in [docs/DECISIONS.md](docs/DECISIONS.md).

| Market | Token | Mint | Signal |
|---|---|---|---|
| Gold | PAXG (Token-2022). XAUt0 exists and is not the default. | `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` | Return, volatility, drawdown from our own prices. Optional headline. |
| Stocks | SPYx by default. NVDAx, QQQx, TSLAx, AAPLx are the same issuer pattern. All Token-2022. | SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | Same loop. No Financial Datasets key. xStocks are not offered to US persons; the operator has to be allowed to hold them. |
| ETH | Wormhole WETH, SPL, 8 decimals | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` | Same loop. |
| BTC | cbBTC, SPL, 8 decimals. Wormhole WBTC is the deeper book and is not the default. | `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` | Same loop. |

USDC is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Swaps are `GET /swap/v2/order` then `POST /swap/v2/execute` with an explicit `slippageBps` and a free Jupiter API key (keyless is 0.5 rps). The v6 quote API is gone. xStock value uses the scaled-UI multiplier (SPYx was about 1.0039); raw amount times price is wrong.

**Loop, every few minutes, one agent per tick, started by the fund runtime:**
1. Read the kill switch, daily stop, and pinned active policy. Require fresh reconciled balances/marks and no unresolved wallet attempt. A daily stop uses deterministic sell-to-cash clips, without an LLM and without overriding the kill switch.
2. The LLM returns finite conviction in [-1, 1]. Failure records `conviction: null`, `abstained: true`, hold/current target, then returns before quoting or signing. Valid zero conviction is neutral, not abstention.
3. A valid response maps to a target. Re-check controls, policy, freshness, and limits immediately before signing. Keep every Jupiter signature except the taker slot being filled.
4. Persist decision, signed bytes, signature, request id, and validity before broadcast. Reconcile uncertain execution before any new order. Record confirmed amounts and costs once; quote values remain estimates.

**Job it sells:** `report` (value, return, volatility, drawdown, position, reasoning, and the audit head hash when this report is an anchor).

### Gateway

- `POST /transfers/prepare` reserves a unique intent with immutable direction, amount, and registered source/destination/refund wallets.
- `deposit_to_solana(intent_id, terms)` returns the intent, source receipt, and Solana payout signature.
- `withdraw_to_cardano(intent_id, terms)` returns the intent, source receipt, and Cardano payout tx id.
- `POST /transfers/{intent_id}/receipt` attaches and verifies the source proof after fee lock and principal submission; job input is not mutated.
- `/availability` reports unreserved inventory/quota; atomic preparation is the authoritative check. Reservations and protected refunds survive timeouts and UTC midnight.
- Top-ups are manual.

### Deposit address (mode 2)

The user's deposit lands on one trader's Cardano address. The runtime does the first split and every later round. That trader keeps trading its market. It does not run the allocator.

## 6. Allocation protocol (mode 2)

Performance rounds run every 30 minutes after at least one hour of valid unit-NAV history. The initial equal-weight deployment is separate. Mode 1 has no weight allocator; Mode 2 requires at least three sleeves to show adaptive weights because two 50%-capped sleeves are necessarily 50/50.

1. **Inputs.** Pin the active policy and reconciled unit-NAV snapshots. `report` anchors the audit; it does not fetch a score. Missing history or unresolved prior legs blocks new performance allocation.
2. **Score.** Decayed net unit return divided by volatility, with the interval, half-life, and floors in architecture section 7. Capital flows change units, not return. Zero-score sleeves do not receive in ordinary rounds. All-zero scores hold unless hard-bound repair is required. Replay instead uses section 12's handwritten series.
3. **Weights.** Use the architecture's bounded-simplex projection, never clip/renormalize. Targets sum to one and obey 10% floors and caps at most 50%. Ordinary rounds enumerate hold/send/receive choices with 5-point minimum changes, a 20-point demo (10-point daily) maximum step, frozen paused weights, and one completed-round sender cooldown. Hard-cap repair overrides those smoothing constraints, but never the kill switch or no-receive daily stop. Reject infeasible policy caps; visibly block a later infeasible round.
4. **Objections.** Each agent's LLM may submit `rule_breach` (`cap`, `cooldown`, `kill_switch`, `daily_stop`) or a comment. Code applies a breach only if it recomputes the same one. Comments are stored and do not move weights. Nothing in the objection is a proposed weight.
5. **Execute.** Persist and recover section 4's ordered legs, checking actual balances/fees/caps before each send. Store planned and settled weights, bound-repair overrides, scores, objections, policy version, and every receipt. Pending target weights are not achieved weights.

A daily loss over 5% of net unit NAV from UTC open latches the sleeve stopped for the day, targets cash, and blocks incoming budget. An internal budget send does not trigger that stop. Chat can tighten caps, pause discretionary activity, or lower risk; pending policy activates only at the next runtime boundary. A feasible cap change from 50% to 20% uses a logged 30-point hard repair, not an impossible ordinary 20-point step.

## 7. Backend and web app

Details, including column-level tables and the benchmark formulas, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Monitor (FastAPI + Postgres)

Reads the Payment Service (V2 filter), Solana RPC, and Jupiter Price v3. Writes policies, chat, and the kill switch. No chain keys.

Tables: `agents`, `wallets`, `policies`, `decisions`, `masumi_jobs`, `transfer_intents`, `chain_attempts`, `transfers`, `trades`, `allocation_rounds`, `prices`, `accounting_entries`, `value_snapshots`, benchmark lots, `chat_messages`, `controls`, and `events`. Durable intents and chain-locator uniqueness prevent duplicate payout/accounting. `events` is append-only (`prev_hash`, `hash`); the application role cannot update/delete it. A `report` commits its head on Masumi through `result_hash`.

Equity includes trader capital/purchasing stablecoin, Solana USDC/tokens, principal receivables, and fee prepayments, less expense payables. Gateway inventory and seller revenue are outside the fund. Net PnL is `equity_end - equity_start - contributions + distributions`; gross adds recognized costs back. Internal budget flows cancel at fund scope. Actual network fees paid from excluded ADA/SOL float create a liability once; repayment is not a second expense. Service fees are recognized on delivery, not twice on lock and collection. Execution costs already reduce assets. Min-UTxO and refundable rent remain float. No "Masumi 5%" fee is invented while V2's rate is zero.

Ownership units adjust on capital flows, while net NAV per unit measures performance and daily loss. Mode 1's benchmark tracks hypothetical token lots and proportional redemptions. Mode 2 fixes shadow ownership in actual sleeve NAV series, ignoring internal reallocations. Both account for withdrawals and disclose the actual-fill approximation.

### Web app (Next.js)

Profile, audit (Cardanoscan, Solscan, Masumi job link, hashes), team chart, chat, controls. Poll the monitor. Mutating routes need one operator token. Preprod pages say the money is play money.

Chat answers from the database or proposes a policy diff. Confirmation validates feasibility and expected version, returning a pending policy or 422/409. The next runtime boundary activates it; the UI distinguishes pending policy, active limits, and actually settled weights.

## 8. Safety limits (in code, not prompts)

- **Allowed tokens:** USDC plus one mint per agent. Anything else is rejected before a transaction is built.
- **Trade limits:** max trade as a percent of value and an absolute USD cap, explicit `slippageBps`, one in-flight swap per agent, daily loss stop.
- **Allocation limits:** section 6. The LLM does not get a path around them.
- **Kill switch:** check at admission and before signing. Stops new trades, allocation sends, and gateway admissions; existing funded obligations, reconciliation, and refunds remain recoverable. Cash-out is explicit, not automatic.
- **Gateway caps:** atomic per-job/daily reservations, including pending prior-day work. No payout without verified, exclusively claimed source principal.
- **Keys:** separate capital/purchasing/selling keys with one active signer each; only service-specific env entries reach each process. Solana keys stay in their signers. No admin keys or signed payloads in prompts/public logs.
- **Size:** architecture section 16's offline/Preprod gates first, then an operator-authorized few-dollar mainnet qualification flow, then explicit arming of normal automation.

## 9. Phases

The adaptive demo is phases 0-2 plus profile and audit. Cut chat, then the dashed line, then one crypto sleeve; retain at least three sleeves for changing Mode 2 weights. Cutting both ETH and BTC leaves a fixed 50/50 two-sleeve fund, suitable for funding/trading/audit but not adaptive allocation. Mode 1 remains a valid smaller live demonstration.

### Phase 0 — setup

**Tasks:**
- Monorepo as in section 3 of the architecture: `agents/` (common, trader, gateway, facilitator), `monitor/`, `web/`, `infra/`.
- Our own `infra/docker-compose.yml`: Postgres, the Masumi payment service (upstream has a Dockerfile and no compose file), the facilitator. Admin key, `ENCRYPTION_KEY`, Blockfrost keys.
- Disjoint capital, purchasing, and selling keys for the gateway and one trader; budget collateral/fee reserves by wallet. Fast poll intervals, V2 registration, required source-index selection, and persisted buffered deadlines.
- Solana RPC and one devnet wallet per process, for ATA plumbing only.
- LLM API key. Jupiter API key. No Financial Datasets key.

**Done when:** both agents are on the Preprod registry as V2, one escrow job has gone FundsLocked → result submitted → withdrawable on our short deadlines, and one tUSDM x402 send is on Preprod Cardanoscan. Matching a devnet balance to tUSDM is not the goal.

### Phase 1 — mode 1

**Tasks:**
1. Reserved gateway deposit/withdraw intents, receipt validation/deduplication, same-chain principal refunds, and separate MIP-003 fee refunds. Persist signed attempts and recover crashes/unknown outcomes.
2. One trader (SPYx or PAXG), the loop, Jupiter swaps, limits, `report`.
3. Funding and cash-out.
4. Reconciled accounting, unit NAV, sampler, profile, audit. Test fees, cash-outs, and principal in transit before claiming PnL.
5. Pass architecture section 16's relevant offline/Preprod gates, authorize the few-dollar mainnet qualification flow, then arm the demo budget ($100-250 per sleeve).

**Done when:** fund, convert, buy, sell, and cash out with every step audited. Mainnet wallets plus claims/liabilities reconcile within declared raw-unit dust, and the PnL identity includes contributions/distributions and every expense once. Preprod verifies plumbing and recovery, not a real stablecoin peg.

### Phase 2 — mode 2

**Tasks:**
1. Four traders from one codebase, each with its own wallets and registry entry.
2. Deposit address and the first split, done by the runtime.
3. Bounded projection, hard-repair precedence, and idempotent partial-round recovery as in section 6. Buffer first.
4. Team chart with round markers.

**Done when:** three live rounds settle or record valid no-change reasons with actual weights and tx links. An offline three-round fixture proves a gain and give-back without changing the live score. Infeasible caps, stop restrictions, and partial-round restart pass the acceptance cases.

### Phase 3 — chat and strategy control

**Tasks:**
- Chat proposes a diff; version-checked confirmation creates a feasible pending policy; the runtime activates it at the next boundary. The trader LLM cannot write weights or adopt a pending version early.
- Questions answered from the monitor.
- Dashed no-reallocation line, defined in the architecture.

**Done when:** a feasible "cap stocks at 20%" activates at the next boundary and is reflected in the next completed repair/round, including the 50%-to-20% test. Stale/infeasible requests and blocked settlement are visibly rejected or pending, not falsely reported as achieved.

### Phase 4 — demo hardening

**Tasks:**
- Live book running early enough that the chart has real hours on it.
- Kill switch drilled once.
- Gateway inventory topped up. No bridge hop during the demo.
- A recorded walkthrough in case the network stalls on stage.

Required gates for all phases are the architecture's section 16 cases: duplicate receipts, crash windows, late confirmations, original-chain refunds, fee/cash-flow identities, constrained allocation, LLM abstention, and last-moment safety checks. They must become automated implementation tests; checking in these documents does not complete a gate.

## 10. Demo script (about 3 min)

1. The profile shows the deposit in USDCx, with a Cardano tx link. If this is Preprod, the page already says so.
2. The audit shows the x402 capital payment and the gateway job: fee locked, Solana signature returned. Fee collection can still be pending. That is normal.
3. The team chart: four lines, markers where budget moved. A marker shows the reason and the transfers.
4. In chat, "cap BTC at 20%". Confirm the policy. The next round applies it.
5. Net profit after fees, against buy-and-hold. A few hours of returns are mostly noise. The demo shows the mechanism, not an edge.

## 12. One-minute pitch

Section 10 is the live walkthrough. This section is the one-minute stage pitch. The fund cannot show two or three months of allocation by waiting, so the pitch plays a paper tape. Prices on that tape are the downloaded bars (Binance BTC and ETH, a free S&P series). The score is not computed from those bars.

Each sleeve has a handwritten series of about 8–12 points, one point per frame, for example BTC `[0.80, 0.84, 0.87, 0.40]`. ETH and the S&P sleeve have their own series of the same length.

- A small step, such as `0.80` to `0.84`, only moves budget through the weight rules in section 6.
- A large drop is the shock. `0.87` to `0.40` is the example. The rule is a fall of more than `0.20` from the previous point. That agent sells toward cash and is blocked from receiving budget. Its share of the fund falls by at most 20 points in that round. The slice that moves can be bought by another sleeve. The rest of the sale stays as cash on the sleeve that dropped. The series is written so this happens once.
- The other agents do not meet and do not propose a new strategy. Objections still have to name a rule the code can recompute.
- The number is not a dial from gold to BTC. Each sleeve has its own series. A headline does not change the score. If the caption says "BTC crash" and the BTC price did not fall, the BTC score stays where it was. Live, that headline can only nudge that sleeve's next conviction, inside the position cap, unless we have tagged it as an emergency.

The runtime runs those rules on the series and stores the paper trades. The profile adds the trades to the price bars, so the history matches the chart. The player reads the stored rows. It does not recompute the score while the clock runs.

The series is replay-only. After the switch, live rounds use the return-over-volatility score in section 6. The handwritten `0.40` is not that formula, and the pitch does not say it is. Replay rows stay out of the Masumi audit. The build spec is [docs/DECISIONS.md](docs/DECISIONS.md) and section 15 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 11. Checked before building

External observations verified 8 Oct 2026 unless noted. The 9 October contract/accounting corrections above supersede older design assumptions; implementation acceptance gates remain open.

- [x] Mints and demo-size liquidity: PAXG, SPYx and the other four xStocks, Wormhole WETH, cbBTC. See section 5. XAUt0, Wormhole WBTC, native WBTC, zBTC, and tBTC were looked at and are not defaults.
- [x] x402 `assetTransferMethod: "masumi"` locks the V2 escrow and cannot be driven by the Payment Service. Direct (`default`) is the capital path. It does not charge 5%.
- [x] USDCx mainnet unit `1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34` + `5553444378`. Acquire via the xReserve portal before the demo. Preprod Masumi stablecoin is tUSDM, not USDCx.
- [x] Registry: one Plutus mint plus min-UTxO, and a ≥5 ADA collateral UTxO on the selling wallet. The "1.5 + 1.5 ADA" figure is not in the docs. Registration does not probe the URL; buyers do.
- [x] Masumi payments are required for this build, not only a partner-track nice-to-have.
- [x] xStocks are not offered to US persons (also UK, Canada, Australia, sanctioned jurisdictions). Constraint on the operator. The chain will still fill.
- [x] Jupiter: Swap v2 on `api.jup.ag`, free key at 1 rps, keyless at 0.5 rps. `/execute` has a separate bucket.
- [x] Hydra is implemented and is a 2-party channel we would have to host. Out of scope.

Still true as operating constraints, not open research: export Cardano mnemonics to the env file before the first payment-service restart (`ENCRYPTION_KEY` loss bricks the node's copy), and do not copy `.env.example` poll intervals.

- [ ] Implement and pass architecture section 16's offline accounting, allocation, idempotency, and safety cases.
- [ ] Pass the real Preprod/devnet adapter and recovery checks with separate signer wallets.
- [ ] Reconcile the bounded mainnet qualification flow before explicitly enabling normal automation.

## 12. References

- [docs/DECISIONS.md](docs/DECISIONS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- HedgeAgents paper: `~/Downloads/2502.13165v1.pdf`
- `ai-hedge-fund` v2.5.0: https://github.com/virattt/ai-hedge-fund (`hedge_fund/paper/ledger.py`, `hedge_fund/risk/limits.py`)
- Masumi docs: https://www.masumi.network/dev/masumi/documentation
- Masumi payments: https://www.masumi.network/dev/masumi/core-concepts/payments
- Masumi x402: https://www.masumi.network/dev/masumi/core-concepts/x402
- Masumi fees: https://docs.masumi.network/core-concepts/transaction-fees
- Python SDK: https://github.com/masumi-network/pip-masumi
- Payment service: https://github.com/masumi-network/masumi-payment-service
- xStocks: https://xstocks.fi/
