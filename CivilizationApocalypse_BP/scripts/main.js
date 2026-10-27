import { system, world } from "@minecraft/server";
import { registerDebugCommands } from "./commands/debug.js";
import { registerInspectionCommands } from "./commands/inspect.js";
import { registerCivCommands } from "./commands/civ.js";
import { registerGateCommands } from "./commands/gates.js";
import { registerPhysicalCommands } from "./commands/physical.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStarterCommands } from "./commands/starter.js";
import { registerWelcomeOnJoin } from "./events/welcome.js";
import { registerSeedBeacon } from "./integration/beaconBindings.js";
import { registerLedger, registerLedgerDevGate } from "./integration/ledgerBindings.js";
import { createPeopleRuntime } from "./integration/peopleRuntime.js";
import { registerPeopleCommand } from "./commands/people.js";
import { createPeopleStreets } from "./integration/peopleStreets.js";
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
registerSeedBeacon(kingdomStore);
// The people runtime is the only thing that turns the hourly kingdom state into entities. It stays off
// until `civ:people on`, and it runs once per accepted simulation hour - never on the 20-tick path.
// Drivers are registered here, one line each, in run order. Nothing spawns from this alone: every driver reads
// the people gate, which a world only gets by running `civ:people on`.
const peopleRuntime = createPeopleRuntime(kingdomStore);
registerPeopleCommand(peopleRuntime);
peopleRuntime.register(createPeopleStreets());
startSimulationLoop(kingdomStore, { onStep: (report) => peopleRuntime.onStep(report) });

// The Commander's Ledger is off unless the development gate is on. The switch always listens, because it is the
// only way to turn the gate on. The Ledger's own handlers register only when the gate is on at load, and early
// execution cannot read the gate, so that check runs on the first tick.
registerLedgerDevGate(kingdomStore);
system.run(() => {
    if (ledgerGateOn(world)) {
        registerLedger(kingdomStore);
    }
});
