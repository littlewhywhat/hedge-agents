import express from "express";
import type { Config } from "./config.js";

export function startGateway(config: Config): void {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true, stub: true });
  });
  app.get("/inventory", (_req, res) => {
    res.json({ cardanoInventory: "0", solanaInventory: "0", available: false });
  });
  app.post("/free", (_req, res) => {
    res.status(501).json({
      error: "stub",
      detail: "Selling to USDC and withdrawing through the gateway is not implemented. Fund the Cardano buffer, or keep the weekly send inside it.",
    });
  });
  app.listen(config.port, () => {
    console.log(`gateway stub listening on ${config.port}`);
  });
}
