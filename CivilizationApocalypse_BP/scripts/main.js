import { world } from "@minecraft/server";
import { registerStatusCommand } from "./commands/status.js";
import { createKingdomStore } from "./kingdom/store.js";
import { registerWelcomeOnJoin } from "./events/welcome.js";

const kingdomStore = createKingdomStore(world);

registerWelcomeOnJoin(kingdomStore);
registerStatusCommand(kingdomStore);
