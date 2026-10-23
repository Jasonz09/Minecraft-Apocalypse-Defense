/**
 * Siege tunables for the long-horizon balance fix (docs/SIEGE_BALANCE.md).
 *
 * Every constant here is read by sim/war.js. config.js is shared with other work, so the
 * numbers that only the siege needs live here instead. Changing one changes the war's
 * outcome for every seed, so keep the reasoning next to the number.
 *
 * Pure data, no imports: this file is safe to load from the offline harness and the pack.
 */

/**
 * Fewest raiders a band can lose in one step when any defender is standing against it.
 *
 * Without this, `round(assault * 0.18)` is zero for a band of one or two, so a remnant left
 * on a wall could never be worn down. This is the load-bearing fix: with the floor removed,
 * every default seed still ends with all five districts lost. The floor is applied only when
 * defenders engage, so an unopposed raid keeps its own rule (sim/war.js
 * RAIDERS_UNOPPOSED_MINIMUM_LOSS).
 */
export const ENGAGED_ATTACKER_MINIMUM_LOSS = 1;

/**
 * Share of the front garrison lost per battle step, scaled by how badly outnumbered.
 *
 * Was 0.04. Lowered to 0.03 to cut how often walls breach: at 0.04 the kingdom still avoids
 * the all-lost outcome, but breaches per run rise from about 85 to about 129 and the share of
 * time with a wall down rises from about 6% to about 9%. This is a playtesting dial, not a fix.
 */
export const DEFENDER_LOSS_RATE = 0.03;

/**
 * Hands in a district's wall crew whatever its builders are doing: the floor under the crew
 * rule in sim/war.js `wallCrewOf`. Repair is still paid for out of `reserves.materials`.
 *
 * Was 1. The crew rule also counts one hand per 20 civilians, so a district with its people at
 * home already repairs with four or more hands and this floor makes no measurable difference
 * on the default runs. It matters for a district that has lost most of its people (fewer than
 * 40 civilians). Requested in the balance brief; kept as a floor, not a tuned number.
 */
export const MIN_REPAIR_CREW = 2;
