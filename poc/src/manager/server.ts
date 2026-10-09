import express, { type NextFunction, type Request, type Response } from "express";
import { openBrain } from "../ai/gemini.js";
import type { Config } from "../common/config.js";
import { ASSETS, type AgentReply, type AgentRequest } from "../common/interface.js";
import { errorText, log } from "../common/time.js";
import { openWallet } from "../chain/cardano.js";
import { openDeskStore, openLedger, openManagerStore } from "../db/pg.js";
import { connect } from "../link/ws.js";
import { type AgentPeers, createManager } from "./cycle.js";

export const startManager = async (config: Config): Promise<void> => {
  const store = openManagerStore(config.databaseUrl);
  const desk = openDeskStore(config.databaseUrl);
  const wallet = openWallet({
    role: "manager",
    mnemonic: config.mnemonics.manager,
    ledger: openLedger(config.databaseUrl),
    settings: { blockfrostUrl: config.blockfrostUrl, blockfrostProjectId: config.blockfrostProjectId },
  });
  await store.saveWallets(config.addresses);
  const agents = Object.fromEntries(
    ASSETS.map((asset) => [asset, connect<AgentRequest, AgentReply, never>(config.agentUrls[asset])]),
  ) as AgentPeers;
  const manager = createManager({
    config,
    store,
    wallet,
    brain: openBrain({ apiKey: config.geminiApiKey, model: config.geminiModel, role: "manager" }),
    agents,
  });

  const app = express();
  app.use(express.json());

  const operator = (req: Request, res: Response, next: NextFunction): void => {
    if (!config.operatorToken || req.header("authorization") !== `Bearer ${config.operatorToken}`) {
      res.status(401).json({ error: "operator token required" });
      return;
    }
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/state", async (_req, res) => {
    res.json({
      ...(await store.state()),
      ...manager.status(),
      agents: Object.fromEntries(ASSETS.map((asset) => [asset, agents[asset].connected()])),
    });
  });

  app.get("/desk", async (_req, res) => {
    res.json({
      ...(await desk.state()),
      live: {
        ...(await store.state()),
        ...manager.status(),
        agents: Object.fromEntries(ASSETS.map((asset) => [asset, agents[asset].connected()])),
      },
    });
  });

  app.post("/start", operator, async (_req, res) => {
    try {
      await manager.start();
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: errorText(error) });
    }
  });

  app.post("/stop", operator, async (_req, res) => {
    await manager.stop();
    res.json({ ok: true });
  });

  app.listen(config.port, () => log("manager", `listening on ${config.port}, wallet ${wallet.address}`));

  if ((await store.state()).running) {
    log("manager", "was running before restart, resuming");
    await manager.start().catch((error) => log("manager", errorText(error)));
  }
};
