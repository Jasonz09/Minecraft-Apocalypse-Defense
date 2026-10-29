import { world as runtimeWorld } from "@minecraft/server";

/**
 * The kingdom's story, once an in-game hour: the simulation already writes what happened into `kingdom.log`
 * ("Saltmere: 12 breached steps with no able defenders - the district has fallen", "Ironquarry: homes COMPLETE"),
 * and this layer reads the new lines and says the important ones out loud.
 *
 * It is a reader, not a writer: nothing here touches the kingdom, an entity or a block, so an hour it cannot
 * understand costs a sentence rather than a rollback. A line it has no short form for is repeated as the
 * simulation wrote it - a narrator that silently drops what it cannot paraphrase is a narrator that hides wars.
 *
 * Silence is the default: the first hour after a load only takes its mark, so joining a long-running world does
 * not dump a day of history, and an hour with no new lines says nothing at all.
 */

export const CHRONICLE_DEFAULTS = Object.freeze({
    /** Clauses one hour may say. Six things happened; three of them are the story. */
    maxClauses: 3,
    /** A clause is one chat-sized breath. */
    maxClauseChars: 120,
    /** The whole line, before Minecraft wraps it. */
    maxLineChars: 320,
});

/**
 * A short form for each thing the simulation is known to write, with the rank that decides which three are told
 * when an hour has more. Ranks are the order a player would tell it in: a district lost outranks a wall held, which
 * outranks a build finished, which outranks a shortage, which outranks work that could not start.
 *
 * `district` is the part before the first ": " of a log line; `body` is the rest.
 * @type {{ re: RegExp, rank: number, say: (district: string, body: string, match: RegExpMatchArray) => string }[]}
 */
const BEATS = [
    { re: /has fallen/, rank: 0, say: (district) => `${district} has fallen` },
    {
        re: /wall (-?\d+) -> (-?\d+), (\d+) raiders? and (\d+) of our soldiers lost/,
        rank: 1,
        say: (district, _body, match) => `${district}: wall ${match[1]} to ${match[2]}, ${match[3]} raider(s) lost`,
    },
    { re: /COMPLETE/, rank: 2, say: (district, body) => `${district}: ${subjectOf(body)} complete` },
    { re: /SHORTAGE/, rank: 3, say: (district, body) => `${district}: ${shortageOf(body)}` },
    { re: /route is blocked|routes are blocked/, rank: 4, say: (district) => `${district}: no evacuation route` },
    { re: /reinforcements short/, rank: 5, say: (district) => `${district}: too few reinforcements` },
    { re: /labour withdrawn/, rank: 6, say: (district) => `${district}: labour withdrawn under attack` },
    { re: /cannot pay/, rank: 7, say: (district, body) => `${district}: ${cannotPayOf(body)}` },
    { re: /stage (\d+)\/(\d+) paid/, rank: 8, say: (district, body, match) => `${district}: ${subjectOf(body)} stage ${match[1]}/${match[2]}` },
];

/** The building a line is about: the word before the verb, which is how the simulation writes it. */
/** @param {string} body */
function subjectOf(body) {
    const words = String(body).trim().split(/\s+/);
    const verb = words.findIndex((word) => /^[A-Z]{3,}$/.test(word));
    return (verb > 0 ? words.slice(0, verb).join(" ") : words[0] ?? "work").toLowerCase();
}

/** The shape the shortage line uses: "SHORTAGE - needed 89 food, had 76". */
/** @param {string} body */
function shortageOf(body) {
    const match = String(body).match(/SHORTAGE\s*-\s*needed\s+([\d.]+)\s+(\w+),\s*had\s+([\d.]+)/);
    return match === null ? "short of supplies" : `${match[2]} short (${match[3]} of ${match[1]})`;
}

/** "cannot pay stage 2 of 4 for 'homes': food 0 < 2" -> "cannot pay for homes". */
/** @param {string} body */
function cannotPayOf(body) {
    const match = String(body).match(/for '([^']+)'/);
    return match === null ? "cannot pay for its works" : `cannot pay for ${match[1]}`;
}

/** Split a log line into its district and its body, the way every simulation message is written. */
/** @param {string} text */
function splitDistrict(text) {
    const at = text.indexOf(": ");
    return at < 0 ? { district: "", body: text } : { district: text.slice(0, at), body: text.slice(at + 2) };
}

/**
 * @param {string} text one `kingdom.log` entry's own words
 * @param {any} config
 * @returns {{ rank: number, clause: string }}
 */
export function clauseOf(text, config = CHRONICLE_DEFAULTS) {
    const line = String(text ?? "").trim();
    const { district, body } = splitDistrict(line);
    for (const beat of BEATS) {
        const match = body.match(beat.re);
        if (match === null) {
            continue;
        }
        return { rank: beat.rank, clause: trim(`${beat.say(district, body, match)}`, config) };
    }
    // Nothing this layer knows how to shorten: say it as the simulation said it, because the simulation is the
    // only thing here that knows what happened.
    return { rank: 9, clause: trim(line, config) };
}

/** @param {string} text @param {any} config */
function trim(text, config) {
    const limit = Math.max(20, Number(config?.maxClauseChars) || CHRONICLE_DEFAULTS.maxClauseChars);
    const clean = String(text).replace(/\s+/g, " ").trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * One hour's line, from the lines the simulation wrote.
 * @param {number} step
 * @param {{ text?: unknown }[]} entries
 * @param {any} [config]
 * @returns {string} empty when there is nothing worth saying
 */
export function composeLine(step, entries, config = CHRONICLE_DEFAULTS) {
    const merged = { ...CHRONICLE_DEFAULTS, ...(config ?? {}) };
    /** @type {{ rank: number, clause: string }[]} */
    const clauses = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const clause = clauseOf(String(entry?.text ?? ""), merged);
        if (clause.clause === "" || seen.has(clause.clause)) {
            continue;
        }
        seen.add(clause.clause);
        clauses.push(clause);
    }
    if (clauses.length === 0) {
        return "";
    }
    const chosen = clauses
        .map((clause, index) => ({ ...clause, index }))
        .sort((left, right) => (left.rank === right.rank ? left.index - right.index : left.rank - right.rank))
        .slice(0, Math.max(1, Number(merged.maxClauses) || 1))
        .map((clause) => clause.clause);
    const limit = Math.max(40, Number(merged.maxLineChars) || CHRONICLE_DEFAULTS.maxLineChars);
    const line = `Hour ${String(step)} - ${chosen.join("; ")}.`;
    return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * @param {{ world?: any, config?: any, readKingdom?: () => any }} [deps]
 * @returns {{ id: "chronicle", onHour: (ctx: any) => number, status: () => Record<string, any>, config: any }}
 */
export function createChronicle(deps = {}) {
    const world = deps.world ?? runtimeWorld;
    const config = { ...CHRONICLE_DEFAULTS, ...(deps.config ?? {}) };
    // The loop's step report carries counts, not the kingdom; a narrator that needed them threaded through the
    // heartbeat would be a second reason to change it. It reads the save it is telling the story of.
    const readKingdom = typeof deps.readKingdom === "function" ? deps.readKingdom : () => undefined;
    /** The highest step already told. -1 until the first hour takes its mark. */
    let told = -1;
    const done = { hours: 0, told: 0, lastLine: "", refused: /** @type {string | null} */ (null) };

    /**
     * One accepted simulation hour.
     * @param {any} ctx the loop's step report, with the kingdom it ran on
     * @returns {number} 1 when a line was said, 0 otherwise
     */
    function onHour(ctx) {
        done.hours += 1;
        const kingdom = ctx?.kingdom ?? readKingdom();
        const step = Number(kingdom?.step);
        if (!Number.isFinite(step)) {
            done.refused = "no kingdom step to tell the hour of";
            return 0;
        }
        const entries = Array.isArray(kingdom.log) ? kingdom.log : [];
        if (told < 0) {
            // The first hour after a load takes its mark and says nothing: a world that has been played for a day
            // must not greet a returning player with a day of history.
            told = step;
            done.refused = "the first hour only takes its mark";
            return 0;
        }
        // `told` is the watermark: the same hour reaching the door twice has no entry past it, so it is silence.
        const fresh = entries.filter((/** @type {any} */ entry) => Number(entry?.atStep) > told && Number(entry?.atStep) <= step);
        told = step;
        const line = composeLine(step, fresh, config);
        if (line === "") {
            done.refused = null;
            return 0;
        }
        done.refused = null;
        done.lastLine = line;
        const everyone = typeof world?.getAllPlayers === "function" ? world.getAllPlayers() : [];
        if (!Array.isArray(everyone) || everyone.length === 0) {
            // Nobody is here to hear it. The hour is still marked told: a returning player gets the next hour,
            // not a backlog.
            done.refused = "nobody is in the world to hear it";
            return 0;
        }
        world.sendMessage(line);
        done.told += 1;
        return 1;
    }

    return {
        id: /** @type {"chronicle"} */ ("chronicle"),
        onHour,
        status: () => ({ hours: done.hours, told: done.told, lastLine: done.lastLine, refused: done.refused }),
        config,
    };
}
