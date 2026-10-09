import { loadConfig } from "./config.js";
import { startFacilitator } from "./facilitator.js";
import { startGateway } from "./gateway.js";
import { startAgent } from "./http.js";

const config = loadConfig();
if (config.processName === "facilitator") startFacilitator(config);
else if (config.processName === "gateway") startGateway(config);
else void startAgent(config);