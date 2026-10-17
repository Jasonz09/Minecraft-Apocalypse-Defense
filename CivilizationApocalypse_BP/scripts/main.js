import { world } from "@minecraft/server";
import { registerDebugCommands } from "./commands/debug.js";
import { registerInspectionCommands } from "./commands/inspect.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWelcomeOnJoin } from "./events/welcome.js";
import { startSimulationLoop } from "./integration/simulationLoop.js";
import { createKingdomStore } from "./kingdom/store.js";

/**
 * Entry point. Everything at this scope is either a pure construction of the store object
 * or an event subscription, because Script API v2 runs scripts in early execution: world
 * state is not available yet, and touching it here would throw before the first tick.
 */

const kingdomStore = createKingdomStore(world);

registerWelcomeOnJoin(kingdomStore);
registerStatusCommand(kingdomStore);
registerInspectionCommands(kingdomStore);
registerDebugCommands(kingdomStore);
startSimulationLoop(kingdomStore);
