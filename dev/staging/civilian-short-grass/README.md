# Exact short-grass walking support — isolated proposal

Native installed162 refused an already unique admitted D5 civ1 solely for `minecraft:short_grass` body clearance at (-194,63,-465). This stage preserves that plant instead of clearing it. It is not installed and does not claim native passage or daily farm work.

Three proposed production files are pinned against the current source: people/walkSafety.js, integration/civilianTravel.js and people/workRoutePreview.js. Driver baseline SHA is 9E719476E0DA1687777EF8E337D77455BA6D92EBB436B51937299D2B9D48FD3E.

`isTravelBodyClear` permits exactly AIR and short_grass; the existing `isTravelBodyAir` remains strict AIR for compatibility. Footing is unchanged: short grass is not floor support. Fern, tall grass, large fern, dry grass, crops, vines, doors/gates/fences, liquids, hazards and unknown IDs remain refused. There is no isSolid/replaceable/family fallback or block write.

The actual full swept driver changes only the shared body predicate call. Footing, read limits256, late native identity/position/source/threat checks, velocity validation, impulse speed/force, flat height/tolerance, same timer and default-off behavior are unchanged. The planner uses the same predicate and retains each admitted primitive feet/head/rise ID, requiring exact unchanged IDs on its fresh path reread (even short_grass→AIR is refused). It adds no native reads or search/node/path quota. Preview remains read-only and never grants motion.

48 focused cases pass (1958.4023 ms): existing current driver/planner controls plus five new grass-specific cases. Tests use an explicit exact-three-source overlay and the existing small synthetic source-stream seam; they do not load a real city plan or validate the native world. Strict isolated root-option TypeScript passes. No full gate, deployment or native test has run.

Run: `node --import ./dev/staging/civilian-short-grass/register.mjs --test dev/staging/civilian-short-grass/civilian-travel.test.mjs dev/staging/civilian-short-grass/civilian-loaded-route-preview.test.mjs`

Typecheck: `npx.cmd tsc -p dev/staging/civilian-short-grass/tsconfig.json --noEmit`

## Evidence limits and next native check

The official [Bedrock block identifier list](https://learn.microsoft.com/en-us/minecraft/creator/commands/enums/block?view=minecraft-bedrock-stable) confirms the exact short_grass identifier. Mojang's [Taking Inventory: Grass](https://www.minecraft.net/en-us/article/taking-inventory--grass) describes the plant; neither retrieved primary document supplies its built-in Bedrock collision-box definition. No undocumented native collision API or inference from a generic block property is introduced. This is a narrow explicit gameplay policy whose actual passage still needs native acceptance.

After central review/full verification/deployment: freshly inspect D5 group1 identity/admission/feet and grass, run the same opt-in `civ:people travel start-near district=5 group=1 length=1 cadence=1` during its WORK phase, retain bounded trace, inspect stop, and verify the exact grass remains. Refuse a changed actor, unsafe footing, unloaded sweep or nearby threat; never teleport/spawn an actor or remove plants to make the test pass. Real passage, arrival/hold/return and identity across rejoin remain separate gates.
