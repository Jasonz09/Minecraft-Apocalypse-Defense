import { ItemLockMode, ItemStack, system, world } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
import { reply } from "../commands/reply.js";
import { CIV_EVENT_IDS } from "../config.js";
import { listGates } from "../sim/gatecontrol.js";
import { createLedgerDevGate, ledgerGateOn } from "../ledger/devgate.js";
import { createLedgerUi } from "../ledger/runtime.js";
import { startGateSelfTest } from "./civGates.js";
import { DISTRICT_INDEXES, abortCivJob, civAbortLines, sessionStatus } from "./civBuilder.js";
import { activeKind, isBusy } from "./districtBuilder.js";
import { getGateAdapter, readGateRecord, readGateRegistry, setUnmanagedMode } from "./gateAdapter.js";

/**
 * The ONLY file that imports `@minecraft/server-ui`, and the only Ledger file that touches `@minecraft/server`.
 * It hands the real objects to ledger/runtime.js and ledger/devgate.js and wires each service to the existing
 * function that the matching command already calls. It holds no rule of its own.
 *
 * Nothing runs at import. main.js calls registerLedgerDevGate() unconditionally (the switch must always listen)
 * and registerLedger() only while the development gate is on.
 *
 * @typedef {ReturnType<typeof import("../kingdom/store.js").createKingdomStore>} KingdomStore
 */

/** One Ledger runtime per world, created on first registration. @type {ReturnType<typeof createLedgerUi> | undefined} */
let ledger;
/** @type {ReturnType<typeof createLedgerDevGate> | undefined} */
let devGate;

/**
 * Gate services (SERVICE_CONTRACT in ledger/actions.js). They share the world's one gate adapter, the same instance
 * the gate commands use.
 * @param {KingdomStore} kingdomStore
 */
function gateServices(kingdomStore) {
    const adapter = getGateAdapter(kingdomStore);
    return {
        /** @param {string} gateId */
        retryNow: (gateId) => adapter.retryNow(gateId),
        pump: () => adapter.pump(),
        /** @param {string} gateId @param {string} mode */
        setUnmanagedMode: (gateId, mode) => setUnmanagedMode(gateId, mode),
        /** @param {string} gateId @param {(report: { pass: boolean, lines: string[] }) => void} done */
        startSelfTest: (gateId, done) => startGateSelfTest(adapter, kingdomStore, gateId, done),
    };
}

/** Civilization services (SERVICE_CONTRACT in ledger/actions.js). Each one is an existing function. */
const civServices = {
    abort: () => abortCivJob(),
    /** @param {ReturnType<typeof abortCivJob>} result @param {string} resumeId */
    abortLines: (result, resumeId) => (result === undefined ? [] : civAbortLines(result, resumeId)),
    /**
     * Runs `civ:generate_resume district=N` as the player, so every refusal and the checksum check are the
     * command's own. The result is "requested": the outcome is reported in chat by the command.
     * @param {any} player @param {number} districtIndex
     * @returns {{ ok: boolean, reason: string | null }}
     */
    resume: (player, districtIndex) => {
        if (!DISTRICT_INDEXES.includes(districtIndex)) {
            return { ok: false, reason: `there is no district ${String(districtIndex)}` };
        }
        try {
            player.runCommand(`scriptevent ${CIV_EVENT_IDS.resume} district=${String(districtIndex)}`);
            return { ok: true, reason: null };
        } catch (error) {
            return { ok: false, reason: String(error) };
        }
    },
};

/**
 * The live status the menus read. Built only from existing readers; never throws into the runtime.
 * @param {KingdomStore} kingdomStore
 */
function liveStatus(kingdomStore) {
    const adapter = getGateAdapter(kingdomStore);
    // A civilization job that is still planning has no session; the menus report it as no build running.
    const busy = isBusy() && !String(activeKind()).startsWith("civ-") ? String(activeKind()) : undefined;
    const loaded = kingdomStore.load();
    const simulated = loaded.kingdom ? listGates(loaded.kingdom).map(({ gate }) => String(gate.id)) : [];
    const unmanaged = readGateRegistry()
        .gates.filter((entry) => entry.role === "unmanaged")
        .map((entry) => ({
            id: String(entry.id),
            purpose: String(entry.purpose ?? ""),
            between: /** @type {string[]} */ ([]),
            mode: entry.mode,
            actual: readGateRecord(String(entry.id))?.actual ?? "open",
        }));
    const moving = [...simulated, ...unmanaged.map((entry) => entry.id)].filter((id) => adapter.isRunning(id));
    return { civ: { session: sessionStatus(), busy }, gates: { unmanaged, moving } };
}

/**
 * Subscribes the Ledger's item use, player leave and recovery command. Idempotent.
 * @param {KingdomStore} kingdomStore
 * @returns {boolean} true the first time
 */
export function registerLedger(kingdomStore) {
    if (ledger === undefined) {
        ledger = createLedgerUi({
            world,
            system,
            ui: { ActionFormData, MessageFormData },
            ItemStack,
            ItemLockMode,
            kingdomStore,
            services: { gates: gateServices(kingdomStore), civ: civServices },
            live: () => liveStatus(kingdomStore),
            gateOpen: () => ledgerGateOn(world),
        });
    }
    return ledger.register();
}

/**
 * Subscribes the development switch `civ:ledger_devgate`. Idempotent. Turning the gate on calls registerLedger().
 * @param {KingdomStore} kingdomStore
 * @returns {boolean} true the first time
 */
export function registerLedgerDevGate(kingdomStore) {
    if (devGate === undefined) {
        devGate = createLedgerDevGate({ world, system, reply, enable: () => registerLedger(kingdomStore) });
    }
    return devGate.register();
}
