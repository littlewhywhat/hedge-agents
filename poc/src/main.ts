import { startAgent } from "./agent/server.js";
import { startBroker } from "./broker/server.js";
import { loadConfig } from "./common/config.js";
import { migrate } from "./db/migrate.js";
import { startManager } from "./manager/server.js";

const config = loadConfig();
await migrate(config.databaseUrl);
if (config.processName === "manager") await startManager(config);
else if (config.processName === "broker") await startBroker(config);
else await startAgent(config);
