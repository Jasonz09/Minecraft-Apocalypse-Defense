import { DEFAULT_SEED, KINGDOM_SCHEMA_VERSION } from "../config.js";
import { createV2Kingdom, findValidationProblems } from "./state.js";

/**
 * One entry per schema step. Each upgrade takes the previous shape and returns the
 * next shape; they are applied in sequence, so a v1 save can still be read when the
 * current schema is v5.
 *
 * @type {{ [fromVersion: number]: (state: any) => any }}
 */
const upgrades = {
    1: (state) =>
        createV2Kingdom({
            name: state.name,
            seed: DEFAULT_SEED,
            districts: (state.districts ?? []).map((district, index) => ({
                id: typeof district?.id === "string" ? district.id : `district-${String(index + 1)}`,
                name: typeof district?.name === "string" ? district.name : `District ${String(index + 1)}`,
                civilians: district?.civilians,
                soldiers: district?.soldiers,
            })),
        }),
};

/**
 * @param {any} value
 */
export function readSchemaVersion(value) {
    const version = value?.schemaVersion;
    return typeof version === "number" && Number.isFinite(version) ? version : undefined;
}

/**
 * @param {any} value
 * @returns {{ kingdom?: any, fromVersion?: number, toVersion?: number, path?: number[], problems?: string[] }}
 */
export function migrateKingdom(value) {
    const start = readSchemaVersion(value);
    if (start === undefined) {
        return { problems: ["saved state has no schemaVersion"] };
    }
    if (start > KINGDOM_SCHEMA_VERSION) {
        return { problems: [`saved state is v${String(start)}, newer than this pack (v${String(KINGDOM_SCHEMA_VERSION)})`] };
    }
    if (start === KINGDOM_SCHEMA_VERSION) {
        return { kingdom: value, fromVersion: start, toVersion: start, path: [] };
    }

    let current = value;
    const /** @type {number[]} */ path = [];
    for (let version = start; version < KINGDOM_SCHEMA_VERSION; version += 1) {
        const upgrade = upgrades[version];
        if (upgrade === undefined) {
            return { problems: [`no migration path registered from schema v${String(version)}`] };
        }
        try {
            current = upgrade(current);
        } catch (error) {
            return { problems: [`migration v${String(version)}->v${String(version + 1)} threw: ${String(error)}`] };
        }
        path.push(version + 1);
    }

    const problems = findValidationProblems(current);
    if (problems.length > 0) {
        return { problems: [`migrated state failed validation: ${problems.join("; ")}`] };
    }
    return { kingdom: current, fromVersion: start, toVersion: KINGDOM_SCHEMA_VERSION, path };
}
