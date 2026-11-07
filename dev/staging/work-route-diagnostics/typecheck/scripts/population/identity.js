import { compareText, parseGroupId } from "./groups.js";
import { POP_TAG_NAMESPACE, POP_TAG_PREFIX } from "./settings.js";

// Identity of a physical entity is a tag: `civpop:v1:<groupId>`. The tag is the only thing that binds an
// entity to a simulation record, so this module is strict about what it claims and deliberately blind to
// everything else. A tag outside the `civpop:` namespace is someone else's and is never read, changed or removed.

const OWN_PREFIX = `${POP_TAG_NAMESPACE}:`;

/**
 * @param {string} groupId
 * @returns {string} the canonical tag for a group
 */
export function tagFor(groupId) {
    return `${POP_TAG_PREFIX}${groupId}`;
}

/**
 * Reads an entity's tags.
 *  - `claims`: canonical group ids this entity asserts (sorted, unique);
 *  - `unreadable`: our namespace, but not a group tag we understand (a future version, garbage);
 *  - `ownTags`: every tag in our namespace, which is what a retag is allowed to change;
 *  - `foreign`: how many tags belong to someone else (counted, never interpreted).
 * @param {readonly unknown[]} tags
 * @returns {{ claims: string[], unreadable: string[], ownTags: string[], foreign: number }}
 */
export function classifyTags(tags) {
    /** @type {Set<string>} */
    const claims = new Set();
    /** @type {string[]} */
    const unreadable = [];
    /** @type {string[]} */
    const ownTags = [];
    let foreign = 0;
    for (const tag of tags) {
        if (typeof tag !== "string" || !tag.startsWith(OWN_PREFIX)) {
            foreign += 1;
            continue;
        }
        ownTags.push(tag);
        const groupId = tag.startsWith(POP_TAG_PREFIX) ? tag.slice(POP_TAG_PREFIX.length) : "";
        if (parseGroupId(groupId) !== null) {
            claims.add(groupId);
        } else {
            unreadable.push(tag);
        }
    }
    return { claims: [...claims].sort(compareText), unreadable, ownTags, foreign };
}

/**
 * True when the entity carries exactly one own tag and it is the canonical tag for `groupId`.
 * @param {readonly string[]} ownTags
 * @param {string} groupId
 */
export function isCanonicalFor(ownTags, groupId) {
    return ownTags.length === 1 && ownTags[0] === tagFor(groupId);
}
