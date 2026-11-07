import { STARTER, STARTING_SIMULATION } from "../config.js";
import { createInitialKingdom } from "../kingdom/state.js";

/**
 * Starter-world arming: the pure decision layer.
 *
 * The finished game ships as a Bedrock **world template**, so the city is already standing when
 * a player joins and nothing expensive is generated at join time. That creates a problem the
 * simulation has to answer honestly: the development world where the city was built also holds
 * months of testing progress - battles fought, population drift, refugees, quarantined blobs,
 * half-finished job queues, a development gate unlock. A player must not inherit any of it.
 *
 * So "arming" splits the world's saved state into three kinds:
 *   - **reset** - the kingdom simulation goes back to its published starting values
 *     (400 civilians / 150 soldiers / 5 districts) while keeping the records that say which
 *     districts are physically built, because those describe the *world*, not progress;
 *   - **keep**  - the five-district master plan and the gate records, so procedural
 *     construction stays available for future expansion and rebuilding;
 *   - **wipe**  - development-only residue.
 *
 * Pure module: no Minecraft API, unit-testable in Node.
 */

/**
 * Longest-prefix wins, so `civ:kingdom-quarantine` can be wiped while `civ:kingdom` is kept.
 * Anything matched by neither is reported as unknown and deliberately left alone: this tool has
 * no business deleting another add-on's properties.
 *
 * @param {string[]} keys
 * @param {{ keepKeyPrefixes?: string[], wipeKeyPrefixes?: string[], wipeKeys?: string[] }} [rules]
 * @returns {{ keep: string[], wipe: string[], unknown: string[] }}
 */
export function classifyStarterKeys(keys, rules = STARTER) {
    const keep = /** @type {string[]} */ (rules.keepKeyPrefixes ?? []);
    const wipe = /** @type {string[]} */ (rules.wipeKeyPrefixes ?? []);
    const exactWipe = new Set(rules.wipeKeys ?? []);
    /** @type {{ keep: string[], wipe: string[], unknown: string[] }} */
    const out = { keep: [], wipe: [], unknown: [] };
    for (const key of [...keys].sort()) {
        if(key.startsWith("civ:wall_leaf_trim:")){out.keep.push(key);continue;}
        if (exactWipe.has(key)) {
            out.wipe.push(key);
            continue;
        }
        const keepMatch = keep.filter((prefix) => key.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
        const wipeMatch = wipe.filter((prefix) => key.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
        if (keepMatch === undefined && wipeMatch === undefined) {
            out.unknown.push(key);
        } else if (wipeMatch !== undefined && (keepMatch === undefined || wipeMatch.length > keepMatch.length)) {
            out.wipe.push(key);
        } else {
            out.keep.push(key);
        }
    }
    return out;
}

/**
 * The kingdom a shipped template carries: starting values plus the build records of the world.
 *
 * @param {{ current?: any, templateId?: string, templateVersion?: number[], armedAtStep?: number, notes?: string[] }} input
 */
export function buildStarterBaseline(input = {}) {
    const templateId = typeof input.templateId === "string" ? input.templateId : STARTER.templateId;
    const templateVersion = Array.isArray(input.templateVersion) ? input.templateVersion : STARTER.templateVersion;
    const armedAtStep = Number.isInteger(input.armedAtStep) ? input.armedAtStep : 0;
    const notes = input.notes ?? [];

    const baseline = createInitialKingdom();
    const current = input.current;

    if (current && Array.isArray(current.districts)) {
        const previous = /** @type {any[]} */ (current.districts);
        baseline.name = typeof current.name === "string" ? current.name : baseline.name;
        for (const district of baseline.districts) {
            const from = previous.find((entry) => entry?.id === district.id);
            if (!from) {
                continue;
            }
            // Built geography is world content, not player progress: it ships with the template.
            if (from.civ !== undefined) {
                district.civ = JSON.parse(JSON.stringify(from.civ));
            }
            if (from.physical !== undefined) {
                district.physical = JSON.parse(JSON.stringify(from.physical));
            }
            // Gate geometry is built geography too. Dropping it silently turns every exported
            // gate back into a logical-only record, disconnecting policy and Ledger controls.
            for (const gate of district.gates ?? []) {
                const previousGate = /** @type {any[]} */ (from.gates ?? []).find((entry) => entry.id === gate.id);
                if (previousGate?.mode !== undefined || previousGate?.physical !== undefined) {
                    gate.mode = "auto";
                }
                if (previousGate?.physical !== undefined) {
                    const physical = previousGate.physical;
                    gate.physical = { state: physical.state === "closed" ? "closed" : "open" };
                    for (const field of ["spec", "link", "companions"]) {
                        if (physical[field] !== undefined) {
                            gate.physical[field] = JSON.parse(JSON.stringify(physical[field]));
                        }
                    }
                    // Preserve the real portcullis position without carrying over combat history,
                    // a pending destination, a blocked diagnostic, or a forced policy.
                    gate.state = gate.physical.state === "closed" ? "sealed" : "open";
                }
            }
            if (Number.isInteger(from.soldiers) && from.soldiers !== district.soldiers) {
                notes.push(`${district.name}: garrison reset from ${String(from.soldiers)} to the published ${String(district.soldiers)}`);
            }
            if (Number.isInteger(from.civilians) && from.civilians !== district.civilians) {
                notes.push(`${district.name}: population reset from ${String(from.civilians)} to the published ${String(district.civilians)}`);
            }
        }
    }

    baseline.starter = {
        templateId,
        templateVersion,
        armedAtStep,
        sourceSeed: Number.isInteger(current?.seed) ? current.seed : null,
    };
    return baseline;
}

/**
 * Why this world may not be armed yet. Deliberately strict: an empty or half-built template must
 * never be shipped as if it were the finished civilization.
 *
 * @param {{ kingdom?: any, keys?: string[], job?: { pending?: number, total?: number, state?: string, status?: string } | null, planPresent?: boolean, planStoredKeys?: boolean, planStatus?: string, planningRunning?: boolean, planningDescription?: string, gates?: { status?: string, units?: number, overrides?: string[], moving?: string[], linksMissing?: string[] }, builtRequired?: string[], keysReadable?: boolean, allowArmed?: boolean, farmLighting?: {ready:boolean,reasons?:string[]} }} world
 */
export function starterArmProblems(world = {}) {
    const /** @type {string[]} */ problems = [];
    const kingdom = world.kingdom;

    if (kingdom === undefined || kingdom === null) {
        return ["no kingdom is saved in this world - generate the city first, then arm it for release"];
    }
    if (world.keysReadable === false) {
        problems.push("world state keys cannot be read - cleanup cannot be verified; nothing may be armed or exported");
    }
    // Trial identity and future casualty receipts are authoritative state, not
    // disposable development residue. Never erase them while resetting headcounts.
    if((world.keys??[]).some(key=>key.startsWith("civ:wall_leaf_trim:")))problems.push("wall-leaf maintenance receipts remain; retain every pending, completed or unknown receipt and reconcile release-copy export separately before arming");
    const militaryKeys = (world.keys ?? []).filter((key) => key.startsWith("civ:military_"));
    if (militaryKeys.length > 0) {
        problems.push("military trial state remains - reconcile and explicitly clear the trial on a separate release copy before arming; no selection, binding or receipt may be discarded");
    }
    const farmKeys=(world.keys??[]).filter(key=>key.startsWith("civ:farm_lights:"));
    if((farmKeys.length>0&&world.farmLighting?.ready!==true)||world.farmLighting?.ready===false) {
        problems.push(`farm lighting must finish and its retained journals must verify before arming or export${world.farmLighting?.reasons?.length?`: ${world.farmLighting.reasons[0]}`:""}`);
    }
    if (world.allowArmed !== true && kingdom.starter !== undefined && typeof kingdom.starter.templateId === "string") {
        problems.push(`this world is already armed as '${kingdom.starter.templateId}' - re-arming would discard play state; start from a fresh build world instead`);
    }

    const built = /** @type {string[]} */ (world.builtRequired ?? ["district-1"]);
    const districts = /** @type {any[]} */ (kingdom.districts ?? []);
    for (const id of built) {
        const district = districts.find((entry) => entry.id === id);
        if (!district) {
            problems.push(`${id} is missing from the kingdom record`);
            continue;
        }
        if (district.civ?.status !== "complete") {
            problems.push(`${id} is not physically complete (civ.status = ${String(district.civ?.status ?? "never built")})`);
        }
    }
    for (const district of districts) {
        const status = district.civ?.status;
        if (status === "building") {
            problems.push(`${district.id} is still under construction - finish or abort the build before arming`);
        } else if (status === "paused") {
            // Its only resume handle is the job queue, and arming wipes that queue.
            problems.push(`${district.id} has a build paused at '${String(district.civ?.stage ?? "unknown stage")}' - finish or cancel it, or the shipped world has a half-built district nobody can resume`);
        }
        if (district.physical?.status === "building") {
            problems.push(`${district.id}'s prototype district build is still in progress`);
        }
    }

    const job = world.job;
    if (job && job.status !== undefined && job.status !== "ok" && job.status !== "absent") {
        problems.push(`the construction job queue reads as '${String(job.status)}' - an unreadable queue could still hold unfinished work`);
    }
    if (job && Number(job.pending ?? 0) > 0) {
        problems.push(`${String(job.pending)} construction job element(s) are still pending`);
    }
    if (world.planningRunning === true) {
        problems.push(`a generation session is still running${world.planningDescription ? ` (${String(world.planningDescription)})` : ""} - arming now would let it save development progress over the released baseline`);
    }
    const gates = world.gates;
    if (gates && gates.status !== "ok" && gates.status !== "absent") {
        problems.push(`the gate registry reads as '${String(gates.status)}' - gates whose real state is unknown must not be shipped as if they were settled`);
    }
    for (const override of gates?.overrides ?? []) {
        problems.push(`gate ${String(override)} is under a manual override - return every gate to auto before arming`);
    }
    for (const moving of gates?.moving ?? []) {
        problems.push(`gate ${String(moving)} is still moving - wait for it to settle before arming`);
    }
    for (const missing of gates?.linksMissing ?? []) {
        problems.push(`gate linkage is incomplete: ${String(missing)} - repair links before export`);
    }
    if (world.planPresent !== true) {
        problems.push(
            world.planStoredKeys === true
                ? `the stored master plan cannot be read (status '${String(world.planStatus)}') - districts 2-5 would ship unplanned`
                : "the five-district master plan is not stored; without it districts 2-5 could never be built or rebuilt",
        );
    }
    return problems;
}

/**
 * Read-out for the release notes and the build receipt.
 *
 * @param {{ kingdom?: any, keys?: string[], rules?: any, gates?: any, job?: any }} world
 */
export function describeStarterState(world = {}) {
    const classified = classifyStarterKeys(world.keys ?? [], world.rules);
    const kingdom = world.kingdom;
    const districts = /** @type {any[]} */ (kingdom?.districts ?? []);
    const built = districts.filter((district) => district.civ?.status === "complete").map((district) => district.id);
    return {
        armed: kingdom?.starter?.templateId ?? null,
        templateVersion: kingdom?.starter?.templateVersion ?? null,
        districts: districts.length,
        civilians: districts.reduce((sum, district) => sum + Number(district.civilians ?? 0), 0),
        soldiers: districts.reduce((sum, district) => sum + Number(district.soldiers ?? 0), 0),
        builtDistricts: built,
        keepKeys: classified.keep,
        wipeKeys: classified.wipe,
        unknownKeys: classified.unknown,
        gates: Number(world.gates?.units ?? 0),
        jobPending: world.job?.pending ?? 0,
    };
}

export const STARTER_EXPECTED_POPULATION = {
    civilians: STARTING_SIMULATION.civilians,
    soldiers: STARTING_SIMULATION.soldiers,
    districts: STARTING_SIMULATION.districtCount,
};
