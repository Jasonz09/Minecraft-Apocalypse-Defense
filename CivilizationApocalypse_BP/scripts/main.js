import { system, world } from "@minecraft/server";
import { registerDebugCommands } from "./commands/debug.js";
import { registerInspectionCommands } from "./commands/inspect.js";
import { registerCivCommands } from "./commands/civ.js";
import { registerGateCommands } from "./commands/gates.js";
import { registerPhysicalCommands } from "./commands/physical.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStarterCommands } from "./commands/starter.js";
import { registerWelcomeOnJoin } from "./events/welcome.js";
import { registerLedger, registerLedgerDevGate } from "./integration/ledgerBindings.js";
import { startSimulationLoop } from "./integration/simulationLoop.js";
import { ledgerGateOn } from "./ledger/devgate.js";
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
registerPhysicalCommands(kingdomStore);
registerGateCommands(kingdomStore);
registerCivCommands(kingdomStore);
registerStarterCommands(kingdomStore);
startSimulationLoop(kingdomStore);

// The Commander's Ledger is off unless the development gate is on. The switch always listens, because it is the
// only way to turn the gate on. The Ledger's own handlers register only when the gate is on at load, and early
// execution cannot read the gate, so that check runs on the first tick.
registerLedgerDevGate(kingdomStore);
system.run(() => {
    if (ledgerGateOn(world)) {
        registerLedger(kingdomStore);
    }
});
