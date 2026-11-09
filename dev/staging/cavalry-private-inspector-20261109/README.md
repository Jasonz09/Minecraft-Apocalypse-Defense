# Private two-way cavalry inspector — one-path proposal

Staging only; active191, privateD7D5, worlds, installed packs, Git and UI remain untouched. One production override: integration/peopleStreets.js. No module, listener, timer, cache of last operation, actor writer or terrain probe is added.

Existing command: `/scriptevent civ:people inspect group=district-1:sol:0`. Only an already configured compoundNativeTrial:true profile takes the new branch, and its current private selector must match the requested group. Ordinary false/absent profiles retain the original inspector/status path. NULL shipped profiles cannot enable this through parsed command data.

The private branch lazily reads the SDK world (or an explicit fake-world test injection), completed v3 binding store and exact durable epoch/generation/role IDs. If either role is not durably alive it reports metadata only, not absence/death/seating. For a full pair, it performs two known-ID lookups and exactly two loaded role-tag queries with closest2; type is deliberately not a query filter. Core identity, tags64, loaded unique IDs, dimensions and primitive positions must agree. It samples rider riding.entityRidingOn and mount rideable.getRiders twice, rejects foreign/ambiguous/inconsistent or changed relations, revalidates metadata/private selection and final native identities after callbacks. Reentry is bounded and invalidates the outer proof. An unavailable/throwing native field is held/UNKNOWN, never guessed. Tick is UNKNOWN if unreadable.

The output explicitly prints both live IDs and both direction fields, followed by YES or both-sides-unseated NO. This is a bounded non-atomic read-only observation, not a world lock, write capability or native acceptance by itself. No handle is retained after the command and no actor is adopted/repaired. No death is inferred from unloaded absence. Last seat operation is deliberately not cached or claimed.

## Proof

17/17 central-ready cases PASS185.0593ms, strict copied BP-script191-overlay TypeScript exit0. The same17 assertions also ran through the standalone stage loader; these are repeated runs, not34 distinct cases. Positive/negative cases use real unified-store metadata with fake native handles. They cover seated/unseated, foreign rider, duplicate or unloaded role, wrong type/tags, unavailable component/ID, changed relationship/source/selection, late metadata retag, reentry, partial metadata and zero DP/entity changes.

Default parity runs the actual full accepted-hour streets owner plus ordinary inspection against the frozen baseline implementation using current dependencies. Return values, status strings, native call sequence, spawned records and DP bytes match exactly. Early-safe construction performs no native world or binding read. No heavy/full/native test was run here.

Three proposed paths are ready for review: the one source override, central dev/test/cavalry-private-inspector.test.mjs and an immutable baseline text fixture. Central tests use normal active-production-relative imports and the existing explicitly synthetic cavalry test loader; there is no staging/dist/runtime fallback. The v2-like baseline text is only a default-behavior reference, never the new test target. Generated runtime is validation scaffolding, not deployable source.

Run central-ready checks: `node --test dev/staging/cavalry-private-inspector-20261109/runtime/dev/test/cavalry-private-inspector.test.mjs`.

Strict check: `npx.cmd tsc -p dev/staging/cavalry-private-inspector-20261109/tsconfig.json --noEmit`.

## Variant rule

Do not mutate D7D5 or call it unchanged. Root may review/promote the one guarded source plus tests to ordinaryNULL191, run the new full gate, then derive a NEW private variant. Versus the old frozen191 it has exactly three deliberate pack differences: two compiled private settings plus this inspector source. If measured against a newly verified ordinary191 that already includes the inspector, only the two private settings differ. Rehash the new pack/bundle manifests and keep the original D7D5 receipt intact before any install. Native root should use the existing command above after normal owner birth/seating, without manual /ride commands or NPC teleport.
