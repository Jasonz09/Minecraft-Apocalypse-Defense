import { system, world } from "@minecraft/server";
import { registerDebugCommands } from "./commands/debug.js";
import { registerInspectionCommands } from "./commands/inspect.js";
import { registerCivCommands } from "./commands/civ.js";
import { registerGateCommands } from "./commands/gates.js";
import { registerGateLevers } from "./integration/gateLevers.js";
import { registerPhysicalCommands } from "./commands/physical.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStarterCommands } from "./commands/starter.js";
import { registerWelcomeOnJoin } from "./events/welcome.js";
import { registerSeedBeacon } from "./integration/beaconBindings.js";
import { ledgerEnabled, registerLedger, registerLedgerDevGate } from "./integration/ledgerBindings.js";
import { createPeopleRuntime } from "./integration/peopleRuntime.js";
import { registerPeopleCommand } from "./commands/people.js";
import { createMilitaryCommand } from "./commands/military.js";
import { createMilitaryLifecycleDiagnostics, registerMilitaryLifecycleSignals } from "./integration/militaryLifecycleDiagnostics.js";
import { createPeopleStreets } from "./integration/peopleStreets.js";
import { createCivilianTravel } from "./integration/civilianTravel.js";
import { peopleGateOn } from "./people/gate.js";
import { isBusy } from "./integration/districtBuilder.js";
import { getProgress } from "./integration/civProgress.js";
import { createSiegeDriver } from "./integration/siegeMobs.js";
import { createOrdersDriver } from "./integration/peopleOrders.js";
import { createChronicle } from "./integration/chronicle.js";
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
registerPhysicalCommands(kingdomStore);
registerGateCommands(kingdomStore);
// The lever on a gatehouse tower is the handle a player reaches for; until now the pack placed four per gate
// and listened to none. This makes a press the same decision `civ:gate_open|gate_close` makes.
registerGateLevers(kingdomStore);
registerCivCommands(kingdomStore);
registerStarterCommands(kingdomStore);
registerSeedBeacon(kingdomStore);
// The people runtime is the only thing that turns the hourly kingdom state into entities. It stays off
// until `civ:people on`, and it runs once per accepted simulation hour - never on the 20-tick path.
// Drivers are registered here, one line each, in run order. Nothing spawns from this alone: every driver reads
// the people gate, which a world only gets by running `civ:people on`.
const peopleRuntime = createPeopleRuntime(kingdomStore);
const military=createMilitaryCommand({world,kingdomStore,isBusy:()=>isBusy()||getProgress()!==undefined});
const militaryDiagnostics=createMilitaryLifecycleDiagnostics({readSelection:military.store.load,tick:()=>system.currentTick});
registerMilitaryLifecycleSignals(world,militaryDiagnostics);
const streets=createPeopleStreets({readMilitarySelection:military.store.load,militaryDiagnostics});
const civilianTravel=createCivilianTravel({world,readKingdom:()=>kingdomStore.load().kingdom,
    admittedGroups:()=>streets.admittedGroups(world),isGateOn:()=>peopleGateOn(world),isBusy});
registerPeopleCommand({statusLines:()=>[...peopleRuntime.statusLines(),...civilianTravel.statusLines(),...military.statusLines()],
    inspectCommand:streets.inspectCommand,travelCommand:civilianTravel.command,stopTravel:civilianTravel.stop,
    militaryCommand:(message,event)=>/^diagnostics(?:\s|$)/.test(message)?militaryDiagnostics.command(message):military.command(message,event)});
peopleRuntime.register(streets);
system.runInterval(()=>civilianTravel.onTick(system.currentTick),4);
peopleRuntime.register(createSiegeDriver(kingdomStore));
// Registered last on purpose: the streets driver signs every levy "<district> levy" and the orders driver titles
// some of them officers, so running orders after streets makes the rank the name a player sees at the end of the
// hour. The cost is one re-write per officer per hour, which is cheaper than making the two drivers share a rule.
peopleRuntime.register(createOrdersDriver({readMilitarySelection:military.store.load,admittedGroups:()=>streets.admittedGroups(world)}));
// The chronicle reads the hour the simulation just wrote and says the important lines in chat. It is not a people
// driver: it writes nothing, and it must speak on hours the people layer skips (a district build holds the runtime,
// but the kingdom still fought, built and starved), so it hangs off the loop beside the runtime.
const chronicle = createChronicle({ readKingdom: () => kingdomStore.load().kingdom });
startSimulationLoop(kingdomStore, {
    onStep: (report) => {
        peopleRuntime.onStep(report);
        try {
            chronicle.onHour(report);
        } catch (error) {
            world.sendMessage(`The chronicle fell silent this hour: ${String(error)}`);
        }
    },
});

// Prepared templates enable the ordinary Ledger; unarmed authoring worlds need the development switch.
// Early execution cannot read either saved state, so registration is checked on the first tick and at join.
registerLedgerDevGate(kingdomStore);
system.run(() => {
    if (ledgerEnabled(kingdomStore)) {
        registerLedger(kingdomStore);
    }
});
