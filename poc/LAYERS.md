# Layers

Gray boxes are processes. Yellow boxes hide a third-party API behind a small interface. Blue is the database.

```mermaid
flowchart TB
  browser[browser] --> web

  subgraph processes["processes (src/main.ts picks one by PROCESS)"]
    manager["manager: cycle loop, start/stop HTTP"]
    agent["agent x4: btc, eth, spx, gold"]
    broker["broker: price sim, accounts, fills"]
  end

  subgraph adapters["adapters"]
    link["link: Peer / serve (ws)"]
    chain["chain: Wallet (x402, Evolution SDK, Blockfrost)"]
    ai["ai: Brain (Gemini + rule fallback)"]
    db["db: ManagerStore / AgentStore / BrokerStore / Ledger / DeskStore (pg)"]
  end

  web["web (Next.js)"] -->|HTTP start / stop| manager
  web -->|DeskStore| db

  manager --> link
  agent --> link
  broker --> link
  manager --> chain
  agent --> chain
  broker --> chain
  manager --> ai
  agent --> ai
  manager --> db
  agent --> db
  broker --> db

  chain --> cardano[(Cardano Preprod)]
  ai --> gemini[Google Gemini]
  db --> pg[(Postgres)]

  classDef process fill:#eeeeee,stroke:#666666,color:#222222
  classDef adapter fill:#f6e7a8,stroke:#b08900,color:#3d3200
  classDef store fill:#d6e6ff,stroke:#2458b5,color:#102246
  class manager,agent,broker,web process
  class link,chain,ai,db adapter
  class pg store
```

Types for each layer live in `interface.ts`: `src/common/interface.ts` (domain and socket messages), `src/db/interface.ts`, `src/chain/interface.ts`, `src/ai/interface.ts`, `src/link/interface.ts`, `web/interface.ts`. Only `src/db/pg.ts` imports `pg`, only `src/chain/` imports x402, only `src/ai/gemini.ts` calls Gemini, only `src/link/ws.ts` imports `ws`.

## One cycle

```mermaid
sequenceDiagram
  participant M as manager
  participant A as agent (x4)
  participant B as broker
  participant C as Cardano
  M->>A: stop
  A->>B: withdraw (broker sells the position first)
  B->>C: broker → agent ADA
  A-->>M: report (wallet, deposited, returned, pnl, experience)
  M->>M: Gemini search trends, Gemini allocation, code caps, plan moves
  M->>A: transfer X to manager (over-target agents)
  A->>C: agent → manager
  M->>C: manager → under-target agents
  M->>A: start {strategy}
  A->>C: agent → broker (everything above the fee reserve)
  A->>B: deposit {txId}, broker checks it on chain and credits
  A->>B: buy / sell every DECIDE_SECONDS (Gemini)
  M->>M: wait CYCLE_MINUTES, repeat
```
