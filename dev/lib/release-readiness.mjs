/**
 * Full starter-world RELEASE requirements. These are deliberately stricter than the
 * development template spec: a Hearthgate-only development preview can be staged,
 * but it must never be distributed as the five-district starting kingdom.
 *
 * The receipt is a human-provided account of the in-game verification, NOT proof
 * that can be extracted from Bedrock LevelDB. Always re-test the imported template.
 */
export const RELEASE_DISTRICT_IDS = Object.freeze([
    "district-1", "district-2", "district-3", "district-4", "district-5",
]);

/** @param {any} spec @param {any} receipt */
export function fullReleaseProblems(spec, receipt) {
    const problems = [];
    const defined = Array.isArray(spec?.districts) ? spec.districts : [];
    const required = Array.isArray(spec?.starter?.builtRequired) ? spec.starter.builtRequired : [];
    const built = Array.isArray(receipt?.builtDistricts) ? receipt.builtDistricts : [];

    if (defined.length !== RELEASE_DISTRICT_IDS.length ||
        new Set(defined.map((d) => d?.id)).size !== RELEASE_DISTRICT_IDS.length ||
        RELEASE_DISTRICT_IDS.some((id) => !defined.some((d) => d?.id === id))) {
        problems.push("release requires exactly the five original district records");
    }
    for (const id of RELEASE_DISTRICT_IDS) {
        const district = defined.find((d) => d?.id === id);
        if (!district?.starterWorld || district?.status !== "built") {
            problems.push(`${id} is not marked starterWorld=true and status=built in starter/template.json`);
        }
        if (!required.includes(id)) problems.push(`${id} is not in starter.builtRequired`);
        if (!built.includes(id)) problems.push(`${id} is not in the signed build receipt`);
    }
    if (required.length !== RELEASE_DISTRICT_IDS.length || new Set(required).size !== RELEASE_DISTRICT_IDS.length) {
        problems.push("starter.builtRequired must contain exactly the five original districts");
    }
    if (built.length !== RELEASE_DISTRICT_IDS.length || new Set(built).size !== RELEASE_DISTRICT_IDS.length) {
        problems.push("receipt.builtDistricts must contain exactly the five original districts");
    }
    if (receipt?.armed !== true) problems.push("receipt must confirm the development world was armed");
    if (receipt?.templateId !== spec?.templateId) problems.push("receipt.templateId must match starter/template.json");
    if (receipt?.districts !== 5 || receipt?.civilians !== 400 || receipt?.soldiers !== 150) {
        problems.push("receipt must report the five-district 400-civilian 150-soldier baseline");
    }
    if (receipt?.jobPending !== 0) problems.push("receipt must report zero pending construction jobs");
    if (!Number.isInteger(receipt?.centre?.x) || !Number.isInteger(receipt?.centre?.z)) {
        problems.push("receipt must give the built city's integer centre - it is the only thing the spawn-inside-the-kingdom check can be measured against");
    }
    if (!(Number(receipt?.radius) > 0)) problems.push("receipt must give a positive radius around that centre");
    for (const field of ["worldName", "minecraftVersion"]) {
        if (typeof receipt?.[field] !== "string" || receipt[field].trim().length === 0) {
            problems.push(`receipt.${field} must record which world and which Minecraft build was verified`);
        }
    }
    const verifiedBy = typeof receipt?.verifiedBy === "string" ? receipt.verifiedBy.trim() : "";
    if (!verifiedBy || /output pasted here|your initials|record the/i.test(verifiedBy)) {
        problems.push("receipt.verifiedBy must record actual in-game verification, not the example placeholder");
    }
    return problems;
}

/**
 * The template spec is not what builds the world - the pack is. `civ:starter_arm confirm` enforces
 * `config.js` `STARTER.builtRequired`, while this gate enforces `starter/template.json`; if those two
 * lists diverge, a world that was armed with Hearthgate alone can be stamped READY here.
 *
 * @param {any} spec the parsed starter/template.json
 * @param {{ templateId?: string, templateVersion?: number[], builtRequired?: string[], keepKeyPrefixes?: string[], wipeKeyPrefixes?: string[] }} starterConfig the pack's STARTER block
 * @returns {string[]}
 */
export function starterConfigProblems(spec, starterConfig) {
    const problems = [];
    const label = "CivilizationApocalypse_BP/scripts/config.js STARTER";
    if (starterConfig === null || typeof starterConfig !== "object") {
        return [`${label} could not be read; the release gate cannot compare the in-game rules with the packaged ones`];
    }
    const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
    if (starterConfig.templateId !== spec?.templateId) {
        problems.push(`${label}.templateId '${String(starterConfig.templateId)}' != template.json '${String(spec?.templateId)}'`);
    }
    if (JSON.stringify(starterConfig.templateVersion) !== JSON.stringify(spec?.templateVersion)) {
        problems.push(`${label}.templateVersion must equal template.json templateVersion`);
    }
    if (!same(starterConfig.builtRequired, spec?.starter?.builtRequired)) {
        problems.push(`${label}.builtRequired ${JSON.stringify(starterConfig.builtRequired)} does not match template.json ${JSON.stringify(spec?.starter?.builtRequired)} - arming would accept a world this gate calls incomplete`);
    }
    if (!same(starterConfig.keepKeyPrefixes, spec?.starter?.keepKeyPrefixes)) {
        problems.push(`${label}.keepKeyPrefixes drifted from template.json - what ships and what is wiped must be agreed in both places`);
    }
    if (!same(starterConfig.wipeKeyPrefixes, spec?.starter?.wipeKeyPrefixes)) {
        problems.push(`${label}.wipeKeyPrefixes drifted from template.json`);
    }
    return problems;
}
