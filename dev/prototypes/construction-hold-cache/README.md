# Construction hold routing repro

Read-only audit after installed149 D5 paused at target `(-303,63,-492)` with held rectangle `X[-336,-209], Z[-480,-353]`, reported held=true and64chunks. Target Z is outside that rectangle.

The production `constructionJob` caches the last normal work box in `lastHoldBox`. A tree-apron hold replaces the physical rectangle but leaves this cache intact. Returning to a normal work box with identical bounds bypasses a new hold through the existing already-requested shortcut, although `contains(heldRect,box,9)` is false.

The repro instruments the actual production private construction router, selector, bounding-box calculation and queue. Only operation expansion/execution is injected. Normal box `X[-392,-303],Z[-492,-455]` receives128-square hold `X[-416,-289],Z[-512,-385]`. Tree at `(-304,63,-455)` lacks17blocks at its X edge and borrows exactly the observed native hold `X[-336,-209],Z[-480,-353]`. A later normal window has the same bounds; the unchanged router reaches the native target outside the held rectangle. This proves a concrete matching path, not the exact historical native operation sequence, which is not recorded.

`fix.patch` proposes only invalidating the normal request cache when returning a tree-hold request. The isolated fixed-source variant requests the original A hold before any target read; holds remain64chunks, without increasing rectangles, apron or concurrent area counts. Ordinary held/no-capacity request completion remains finite. No engine writes, tree proof, retry-timeout or refusal logic changes in this prototype.

Run `node --test dev/prototypes/construction-hold-cache/repro.test.mjs`. No active BP/RP/test files are modified by the tests. The proposal must go through full checks and native acceptance before installation.
