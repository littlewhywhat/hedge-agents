export type { DeskAgent, DeskCycle, DeskState, DeskTransfer } from "../src/db/interface.js";

export type ManagerLive = {
  running: boolean;
  looping: boolean;
  halting: boolean;
  cycleId: number | null;
  nextAt: string | null;
  agents: Record<string, boolean>;
};
