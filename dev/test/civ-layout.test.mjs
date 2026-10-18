import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsRoot = join(projectRoot, "CivilizationApocalypse_BP", "scripts");
const load = (...parts) => import(pathToFileURL(join(scriptsRoot, ...parts)).href);

const { BLUEPRINTS2, BLUEPRINT_VARIANTS, PALETTE_V2, BLUEPRINT_VERSION, expandBlueprint, rotatedSize, rotateInBox } = await load("structures", "blueprints2.js");
const { PALETTE } = await load("structures", "palette.js");
const { PALETTE2 } = await load("structures", "palette2.js");
const { rotateDir, encodeFacing } = await load("structures", "facing.js");
const { zoneDistrict, regionFromPlan, MIN_COMPOSITION, ROLE_ZONES, KIND_GROUP } = await load("civ", "zoning.js");
const { makeLots, rectGap, requiredGap, HOUSE_KINDS, blueprintBlocks } = await load("civ", "lots.js");
const vanilla = await import(pathToFileURL(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "index.js")).href);
const blockStatesSource = readFileSync(join(projectRoot, "node_modules", "@minecraft", "vanilla-data", "lib", "mojang-block.d.ts"), "utf8");

// ------------------------------------------------------------------ fixtures (no CivPlan code needed)

/** Irregular blob: radius modulated by several harmonics; optional holes (lakes) and a partial river strip. */
function makeRegion({ index = 1, role = "residential", seed = 1, r0 = 106, holes = [], river = null, cx = 0, cz = 0 } = {}) {
    const ph = [seed * 1.3, seed * 2.1 + 1, seed * 0.7 + 2, seed * 3.3];
    const radius = (th) => r0 + 11 * Math.sin(3 * th + ph[0]) + 8 * Math.sin(5 * th + ph[1]) + 5 * Math.sin(2 * th + ph[2]) + 3 * Math.sin(9 * th + ph[3]);
    const inside = (x, z) => {
        const dx = x - cx;
        const dz = z - cz;
        if (Math.hypot(dx, dz) > radius(Math.atan2(dz, dx))) return false;
        for (const h of holes) if (Math.hypot(x - h.x, z - h.z) < h.r) return false;
        if (river && x >= river.x0 && x <= river.x1 && Math.abs(z - (river.z + 4 * Math.sin(x / 9))) < river.w / 2) return false;
        return true;
    };
    // labels live on a 4-block grid like the CivPlan raster
    const labelAt = (x, z) => (inside(Math.floor(x / 4) * 4 + 2, Math.floor(z / 4) * 4 + 2) ? index : 0);
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let z = cz - r0 - 40; z <= cz + r0 + 40; z += 4) {
        for (let x = cx - r0 - 40; x <= cx + r0 + 40; x += 4) {
            if (labelAt(x, z) === index) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x + 3); z0 = Math.min(z0, z); z1 = Math.max(z1, z + 3);
            }
        }
    }
    const outline = [];
    for (let k = 0; k < 96; k += 1) {
        const th = (k / 96) * Math.PI * 2;
        outline.push([Math.round(cx + radius(th) * Math.cos(th)), Math.round(cz + radius(th) * Math.sin(th))]);
    }
    return { index, role, labelAt, outline, hq: { x: cx + 26, z: cz - 18 }, bbox: { x0, z0, x1, z1 }, radius, cx, cz };
}

function makeRoadsAndWalls(region, { withRoads = true, withWalls = true } = {}) {
    const { radius, cx, cz } = region;
    const at = (th, f) => [Math.round(cx + radius(th) * f * Math.cos(th)), Math.round(cz + radius(th) * f * Math.sin(th))];
    const wallPath = [];
    for (let k = 0; k < 160; k += 1) wallPath.push(at((k / 160) * Math.PI * 2, 0.985));
    const walls = withWalls ? [{ id: "w", kind: "outer", closed: true, thickness: 3, path: wallPath }] : [];
    const gE = at(0.1, 0.96);
    const gW = at(Math.PI + 0.2, 0.96);
    const gS = at(Math.PI / 2 + 0.3, 0.96);
    const curve = (a, b, bend) => {
        const pts = [];
        for (let k = 0; k <= 24; k += 1) {
            const t = k / 24;
            pts.push([Math.round(a[0] + (b[0] - a[0]) * t + bend * Math.sin(t * Math.PI)), Math.round(a[1] + (b[1] - a[1]) * t + bend * 0.6 * Math.sin(t * Math.PI * 2))]);
        }
        return pts;
    };
    const hq = [region.hq.x, region.hq.z];
    const roads = withRoads
        ? [
              { id: "a1", kind: "arterial", district: region.index, width: 5, path: curve(gE, hq, 14) },
              { id: "a2", kind: "arterial", district: region.index, width: 5, path: curve(gW, hq, -18) },
              { id: "a3", kind: "arterial", district: region.index, width: 5, path: curve(gS, hq, 10) },
          ]
        : [];
    const gates = [gE, gW, gS].map((p, i) => ({ id: `g${i}`, at: { x: p[0], z: p[1] }, axis: "x", width: 5 }));
    return { roads, walls, gates };
}

const ROLES = ["command", "industrial", "agricultural", "commercial", "residential"];
/** Each role gets its own district shape, like the real five regions. */
const district = (role, planSeed = 11) => build(role, 3 + ROLES.indexOf(role), planSeed);
const cache = new Map();
/** Build (and memoise) zoning + lots for a role/seed fixture. */
function build(role, regionSeed, planSeed, extra = {}) {
    const key = JSON.stringify([role, regionSeed, planSeed, extra.key ?? ""]);
    if (!cache.has(key)) {
        const region = makeRegion({ index: ROLES.indexOf(role) + 1, role, seed: regionSeed, ...(extra.region ?? {}) });
        const { roads, walls, gates } = makeRoadsAndWalls(region, extra.rw ?? {});
        const zones = zoneDistrict(region, roads, { seed: planSeed, walls, gates });
        const lots = makeLots(region, zones, roads, { seed: planSeed });
        cache.set(key, { region, roads, walls, gates, zones, lots });
    }
    return cache.get(key);
}

// ------------------------------------------------------------------ independent checkers (do not reuse production code)

/** Continuous-distance road mask from polylines (independent of zoning's raster). */
function roadCells(roads, extraPaths = [], slack = 0.5) {
    const cells = new Set();
    const stampPoint = (x, z, half) => {
        const r = Math.ceil(half + slack + 1);
        for (let dz = -r; dz <= r; dz += 1) {
            for (let dx = -r; dx <= r; dx += 1) {
                const cx = Math.round(x) + dx;
                const cz = Math.round(z) + dz;
                if (Math.hypot(cx - x, cz - z) <= half + slack) cells.add(`${cx},${cz}`);
            }
        }
    };
    for (const road of roads) {
        const half = ((road.width ?? 3) - 1) / 2;
        for (let i = 0; i < road.path.length - 1; i += 1) {
            const [ax, az] = road.path[i];
            const [bx, bz] = road.path[i + 1];
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * 2));
            for (let k = 0; k <= n; k += 1) stampPoint(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, half);
        }
    }
    for (const p of extraPaths) for (const [x, z] of p.path) stampPoint(x, z, ((p.width ?? 3) - 1) / 2);
    return cells;
}

/** every street of the district: the zoning streets plus the ones the lot layout had to add */
const allStreets = (zones, lots) => [...zones.streets, ...lots.extraStreets].map((s) => ({ path: s.path, width: s.width }));

const footprintCells = (lot) => {
    const out = [];
    for (let z = lot.z; z < lot.z + lot.d; z += 1) for (let x = lot.x; x < lot.x + lot.w; x += 1) out.push([x, z]);
    return out;
};
const rectOf = (lot) => ({ x0: lot.x, z0: lot.z, x1: lot.x + lot.w - 1, z1: lot.z + lot.d - 1 });
/** independent gap: number of empty blocks between two footprints along the larger axis separation */
const gapOf = (a, b) => {
    const gx = Math.max(b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
    const gz = Math.max(b.z0 - a.z1 - 1, a.z0 - b.z1 - 1);
    return Math.max(gx, gz);
};

function checkNoOverlapAndSpacing(lots) {
    for (let i = 0; i < lots.length; i += 1) {
        for (let j = i + 1; j < lots.length; j += 1) {
            const a = lots[i];
            const b = lots[j];
            const gap = gapOf(rectOf(a), rectOf(b));
            const need = HOUSE_KINDS.includes(a.kind) || HOUSE_KINDS.includes(b.kind) ? 6 : 4;
            assert.ok(gap >= need, `${a.id} and ${b.id} are only ${gap} apart (need ${need})`);
        }
    }
}

function barrierPoints(region, walls) {
    // barrier cells = the first cells OUTSIDE the district (or inside a lake) plus every stamped wall cell
    const pts = [];
    const inRegion = (x, z) => region.labelAt(x, z) === region.index;
    for (let z = region.bbox.z0 - 1; z <= region.bbox.z1 + 1; z += 1) {
        for (let x = region.bbox.x0 - 1; x <= region.bbox.x1 + 1; x += 1) {
            if (inRegion(x, z)) continue;
            if (inRegion(x + 1, z) || inRegion(x - 1, z) || inRegion(x, z + 1) || inRegion(x, z - 1)) pts.push([x, z]);
        }
    }
    const wallCells = roadCells(walls.map((w) => ({ path: [...w.path, w.path[0]], width: w.thickness })));
    for (const key of wallCells) pts.push(key.split(",").map(Number));
    return pts;
}

/** minimum distance from any footprint cell of the lot to a barrier point */
function minBarrierDistance(lot, pts) {
    let best = Infinity;
    const cells = footprintCells(lot).filter(([x, z]) => x === lot.x || x === lot.x + lot.w - 1 || z === lot.z || z === lot.z + lot.d - 1);
    for (const [x, z] of cells) {
        for (const [px, pz] of pts) {
            const dx = x - px;
            const dz = z - pz;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) best = d2;
        }
    }
    return Math.sqrt(best);
}

function checkLotsStructure({ region, roads, walls, zones, lots }) {
    const roadSet = roadCells(roads, allStreets(zones, lots), 1.3);
    const pts = barrierPoints(region, walls);
    const wallSet = roadCells(walls.map((w) => ({ path: [...w.path, w.path[0]], width: w.thickness })));
    for (const lot of lots.lots) {
        for (const [x, z] of footprintCells(lot)) {
            assert.equal(region.labelAt(x, z), region.index, `${lot.id} leaves the district at ${x},${z}`);
            // the HQ citadel is the one lot that may overbuild the stub of the roads that terminate at the HQ point
            const hqSite = lot.kind === "hq_citadel" && Math.hypot(x - zones.hq.x, z - zones.hq.z) <= 24;
            assert.ok(hqSite || !roadSet.has(`${x},${z}`), `${lot.id} stands on a road at ${x},${z}`);
            assert.ok(!wallSet.has(`${x},${z}`), `${lot.id} stands on a wall at ${x},${z}`);
        }
        // >= 6 empty blocks between the lot and any wall/boundary cell: centre distance >= 7
        const d = minBarrierDistance(lot, pts);
        assert.ok(d >= 7 - 1e-9, `${lot.id} is only ${d.toFixed(2)} from the wall/boundary (need 7 = 6 clear blocks)`);
        const bp = BLUEPRINTS2[lot.blueprint];
        const dims = rotatedSize(bp, lot.rot);
        assert.equal(lot.w, dims.w);
        assert.equal(lot.d, dims.d);
    }
    checkNoOverlapAndSpacing(lots.lots);
}

// ------------------------------------------------------------------ blueprints

const known = new Set(Object.values(vanilla.MinecraftBlockTypes));
const statesCache = new Map();
const statesFor = (id) => {
    if (!statesCache.has(id)) statesCache.set(id, statesForUncached(id));
    return statesCache.get(id);
};
const statesForUncached = (id) => {
    const typeName = `${id.replace("minecraft:", "").split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}States`;
    const match = blockStatesSource.match(new RegExp(`export type ${typeName} = ([^;]+);`));
    if (!match) return undefined;
    if (match[1].startsWith("Record<string, never>")) return [];
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).filter((name) => name !== "BlockStateSuperset");
};

test("palette2 does not collide with palette.js and every token is a valid 1.26 block with valid state names", () => {
    for (const key of Object.keys(PALETTE2)) assert.ok(!Object.hasOwn(PALETTE, key), `palette2 token '${key}' collides with palette.js`);
    assert.equal(Object.keys(PALETTE_V2).length, Object.keys(PALETTE).length + Object.keys(PALETTE2).length);
    const specs = [];
    for (const [name, token] of Object.entries(PALETTE2)) {
        if (token === null) continue;
        for (const spec of token.mix ? token.mix.map((entry) => entry[0]) : [token]) specs.push([name, spec]);
    }
    for (const [name, spec] of specs) {
        assert.ok(known.has(`minecraft:${spec.id}`), `${name}: '${spec.id}' is not a block in this game version`);
        const allowed = statesFor(spec.id);
        const given = Object.keys(spec.states ?? {});
        if (spec.face) given.push(...Object.keys(encodeFacing({ ...spec.face })));
        for (const state of given) {
            assert.ok(allowed, `${name}: no state list found for ${spec.id}`);
            assert.ok(allowed.includes(state), `${name}: ${spec.id} has no state '${state}' (valid: ${allowed.join(", ")})`);
        }
    }
});

test("every blueprint is versioned, unique, complete and uses only known tokens", () => {
    const ids = Object.keys(BLUEPRINTS2);
    assert.ok(ids.length >= 38, `only ${ids.length} blueprints`);
    assert.equal(new Set(ids).size, ids.length);
    for (const [id, bp] of Object.entries(BLUEPRINTS2)) {
        assert.equal(bp.id, id);
        assert.match(id, /_v2$/, `${id} must be versioned`);
        assert.equal(bp.version, BLUEPRINT_VERSION);
        assert.ok(bp.ops.length > 0 && bp.size.every((n) => Number.isInteger(n) && n > 0), id);
        assert.ok(bp.entrances.length >= 1, `${id} needs an entrance`);
        for (const op of bp.ops) {
            if (op.block !== null) assert.ok(Object.hasOwn(PALETTE_V2, op.block), `${id}: unknown token ${op.block}`);
            assert.ok(["set", "fill", "ring", "hollow"].includes(op.op), `${id}: op ${op.op}`);
        }
        const [w, , d] = bp.size;
        const [fx0, fz0, fx1, fz1] = bp.foundation.rect;
        assert.ok(fx0 <= 0 && fz0 <= 0 && fx1 >= w - 1 && fz1 >= d - 1, `${id}: foundation rect must cover the footprint`);
        assert.ok(bp.foundation.depth >= 1 && bp.foundation.depth <= 6, id);
    }
    // the lot-kind table points at real blueprints
    for (const [kind, list] of Object.entries(BLUEPRINT_VARIANTS)) for (const id of list) assert.ok(BLUEPRINTS2[id], `${kind} -> ${id}`);
    for (const required of ["house_s_v2", "house_m_v2", "house_l_v2", "longhouse_v2", "workshop_v2", "smithy_v2", "warehouse_v2", "granary_v2", "mill_v2", "market_stall_v2", "shop_v2", "inn_v2", "stable_v2", "barracks_v2", "drill_ground_v2", "armoury_v2", "hospital_v2", "chapel_v2", "school_v2", "well_v2", "guard_post_v2", "command_hall_v2", "watchtower_v2", "farm_wheat_v2", "farm_irrigated_v2"]) {
        assert.ok(BLUEPRINTS2[required], `missing blueprint ${required}`);
    }
});

test("every blueprint expands in all four rotations: valid ids and states, inside its footprint, doors paired, ladders supported", () => {
    for (const [id, bp] of Object.entries(BLUEPRINTS2)) {
        const baseCount = expandBlueprint(bp, 0).length;
        assert.ok(baseCount > 20, `${id} is nearly empty`);
        for (let rot = 0; rot < 4; rot += 1) {
            const cells = expandBlueprint(bp, rot);
            assert.equal(cells.length, baseCount, `${id} rot ${rot} changes the block count`);
            const dims = rotatedSize(bp, rot);
            const at = new Map();
            for (const c of cells) {
                assert.ok(c.x >= 0 && c.z >= 0 && c.y >= 0 && c.x < dims.w && c.z < dims.d && c.y < bp.size[1], `${id} rot ${rot}: cell ${JSON.stringify(c)} outside ${dims.w}x${bp.size[1]}x${dims.d}`);
                assert.ok(known.has(`minecraft:${c.id}`), `${id}: ${c.id} is not a block in this game version`);
                const allowed = statesFor(c.id);
                for (const state of Object.keys(c.states ?? {})) {
                    assert.ok(allowed?.includes(state), `${id}: ${c.id} has no state '${state}'`);
                }
                assert.ok(!at.has(`${c.x},${c.y},${c.z}`), `${id}: duplicate cell`);
                at.set(`${c.x},${c.y},${c.z}`, c);
            }
            // doors come as lower+upper pairs with matching facing
            for (const c of cells) {
                if (c.states?.upper_block_bit === false) {
                    const top = at.get(`${c.x},${c.y + 1},${c.z}`);
                    assert.ok(top && top.id === c.id && top.states.upper_block_bit === true, `${id}: door at ${c.x},${c.y},${c.z} has no upper half`);
                    assert.equal(top.states["minecraft:cardinal_direction"], c.states["minecraft:cardinal_direction"]);
                    assert.equal(c.states["minecraft:cardinal_direction"], rotateDir("south", rot), `${id}: door must face ${rotateDir("south", rot)} after ${rot} turns`);
                }
            }
            // the declared entrance cell is where the (rotated) door/opening is
            const e = bp.entrances[0];
            const [ex, ez] = rotateInBox(e.at[0], e.at[2], bp.size[0], bp.size[2], rot);
            assert.ok(ex >= 0 && ez >= 0 && ex < dims.w && ez < dims.d, `${id}: entrance outside the footprint`);
            // ladders attach to a solid block behind them
            if (rot === 0) {
                for (const c of cells) {
                    if (c.id === "ladder") assert.ok(at.has(`${c.x},${c.y},${c.z - 1}`), `${id}: ladder at ${c.x},${c.y},${c.z} has nothing behind it`);
                }
            }
        }
    }
});

test("blueprints are physically plausible: footprint floors exist, buildings have a door in the rotated entrance, block estimates are sane", () => {
    for (const [id, bp] of Object.entries(BLUEPRINTS2)) {
        const cells = expandBlueprint(bp, 0);
        const floor = cells.filter((c) => c.y === 0).length;
        assert.ok(floor >= (bp.size[0] * bp.size[2]) * 0.5, `${id}: floor covers only ${floor} of ${bp.size[0] * bp.size[2]} columns`);
        const est = blueprintBlocks(id);
        assert.equal(est.blocks, cells.length);
        assert.ok(est.blocks < 6000, `${id} is huge (${est.blocks})`);
    }
    assert.ok(blueprintBlocks("farm_wheat_v2").farmland >= 250);
    const homes = ["house_s_v2", "house_m_v2", "house_l_v2"].map((id) => BLUEPRINTS2[id]);
    assert.ok(homes[0].size[0] < homes[1].size[0] && homes[1].size[0] < homes[2].size[0], "S < M < L");
    const roofs = new Set(Object.values(BLUEPRINTS2).filter((b) => b.category === "residential").map((b) => expandBlueprint(b, 0).filter((c) => c.id.endsWith("_stairs")).map((c) => c.id).sort().join("|")));
    assert.ok(roofs.size >= 5, "houses should use different roof materials");
});

test("the checkers can fail: a hand-made overlap, a too-small gap and a bad state are all caught", () => {
    const lot = (id, kind, x, z, w, d) => ({ id, kind, x, z, w, d });
    assert.throws(() => checkNoOverlapAndSpacing([lot("a", "warehouse", 0, 0, 10, 10), lot("b", "warehouse", 5, 5, 10, 10)]), /only/);
    assert.throws(() => checkNoOverlapAndSpacing([lot("a", "warehouse", 0, 0, 10, 10), lot("b", "warehouse", 13, 0, 10, 10)]), /only 3 apart/);
    assert.throws(() => checkNoOverlapAndSpacing([lot("a", "house_s", 0, 0, 7, 5), lot("b", "warehouse", 11, 0, 10, 10)]), /need 6/);
    assert.doesNotThrow(() => checkNoOverlapAndSpacing([lot("a", "house_s", 0, 0, 7, 5), lot("b", "warehouse", 13, 0, 10, 10)]));
    assert.equal(gapOf({ x0: 0, z0: 0, x1: 9, z1: 9 }, { x0: 14, z0: 0, x1: 20, z1: 9 }), 4);
    assert.equal(rectGap({ x0: 0, z0: 0, x1: 9, z1: 9 }, { x0: 14, z0: 0, x1: 20, z1: 9 }), 4);
    assert.equal(requiredGap("house_s", "barracks"), 6);
    assert.equal(requiredGap("barracks", "warehouse"), 4);
    assert.ok(statesFor("wooden_door").includes("upper_block_bit") && !statesFor("wooden_door").includes("growth"), "validator knows door states");
    assert.ok(statesFor("wheat").includes("growth") && !statesFor("wheat").includes("upper_block_bit"));
});

// ------------------------------------------------------------------ zoning and lots

test("zoning: each role gets its showpiece zones, a >= 6 setback, >= 15% reserve and real streets", () => {
    for (const role of ROLES) {
        const { zones, region } = district(role);
        assert.equal(zones.degenerate, false, role);
        assert.ok(zones.setback >= 6, role);
        assert.ok(zones.area >= 30000, `${role}: fixture area ${zones.area}`);
        const types = new Set(zones.zones.map((z) => z.type));
        for (const def of ROLE_ZONES[role]) assert.ok(types.has(def.type), `${role}: missing zone '${def.type}' (notes: ${zones.notes.join("; ")})`);
        assert.ok(types.has("reserve") && types.has("commons"), role);
        assert.ok(zones.streets.length >= 8, `${role}: ${zones.streets.length} streets`);
        // reserve measured independently from the raster accessor
        let reserve = 0;
        let total = 0;
        for (let z = region.bbox.z0; z <= region.bbox.z1; z += 1) {
            for (let x = region.bbox.x0; x <= region.bbox.x1; x += 1) {
                if (region.labelAt(x, z) !== region.index) continue;
                total += 1;
                const id = zones.zoneAt(x, z);
                if (id !== 0 && zones.zoneById(id).type === "reserve") reserve += 1;
            }
        }
        assert.ok(reserve / total >= 0.15, `${role}: reserve ${(reserve / total).toFixed(3)} < 0.15`);
        assert.ok(zones.patrol.cells.length > 600, `${role}: patrol lane ${zones.patrol.cells.length}`);
        // zones tile disjoint land: zoneAt must agree with each zone's own cell list
        const owner = new Map();
        for (const zone of zones.zones) for (const c of zone.cells) { assert.ok(!owner.has(c), "cell in two zones"); owner.set(c, zone.id); }
    }
});

test("lots: no overlaps, >= 4 apart (>= 6 for houses), inside the district, off roads/walls, >= 6 clear blocks from the wall", () => {
    for (const role of ROLES) {
        const built = district(role);
        assert.ok(built.lots.lots.length >= 30, `${role}: only ${built.lots.lots.length} lots`);
        checkLotsStructure(built);
        // unique ids, valid blueprints and group labels
        const ids = new Set();
        for (const lot of built.lots.lots) {
            assert.ok(!ids.has(lot.id), `duplicate id ${lot.id}`);
            ids.add(lot.id);
            assert.ok(BLUEPRINTS2[lot.blueprint], lot.blueprint);
            assert.ok(BLUEPRINT_VARIANTS[lot.kind].includes(lot.blueprint));
            assert.ok([0, 1, 2, 3].includes(lot.rot));
            assert.equal(lot.group, KIND_GROUP[lot.kind]);
            assert.equal(lot.district, built.region.index);
        }
    }
});

test("lots: every lot has a frontage point on a road, a straight clear approach from its door, and the road network is connected", () => {
    for (const role of ROLES) {
        const built = build(role, 5, 7);
        const { lots, zones, roads } = built;
        // membership is tolerant (Bresenham-rounded centrelines can sit ~1 block off the exact polyline)
        const roadSet = roadCells(roads, allStreets(zones, lots), 1.6);
        const patrol = new Set(zones.patrol.cells.map(([x, z]) => `${x},${z}`));
        const footprints = new Set(lots.lots.flatMap((l) => footprintCells(l).map(([x, z]) => `${x},${z}`)));
        const dir = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
        // network = roads + streets + patrol lane, 8-connected components
        const net = new Set([...roadSet, ...patrol]);
        const seen = new Set();
        const arterialStart = roads[0].path[0].join(",");
        assert.ok(net.has(arterialStart));
        const queue = [arterialStart];
        seen.add(arterialStart);
        while (queue.length) {
            const [x, z] = queue.pop().split(",").map(Number);
            for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
                const k = `${x + dx},${z + dz}`;
                if (net.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
            }
        }
        for (const lot of lots.lots) {
            const f = lot.frontage;
            assert.ok(roadSet.has(`${f.x},${f.z}`) || patrol.has(`${f.x},${f.z}`), `${lot.id}: frontage ${f.x},${f.z} is not a road cell`);
            assert.ok(seen.has(`${f.x},${f.z}`), `${lot.id}: frontage ${f.x},${f.z} is cut off from the arterial network`);
            // door -> frontage is a straight line in the facing direction
            const [dx, dz] = dir[lot.facing];
            assert.equal(lot.facing, rotateDir("south", lot.rot));
            const expected = [];
            let x = lot.exit.x + dx;
            let z = lot.exit.z + dz;
            while (x !== f.x || z !== f.z) { expected.push([x, z]); x += dx; z += dz; assert.ok(expected.length < 40, `${lot.id}: approach never reaches frontage`); }
            assert.deepEqual(lot.approach, expected, `${lot.id}: approach path`);
            for (const [ax, az] of lot.approach) assert.ok(!footprints.has(`${ax},${az}`), `${lot.id}: approach crosses a building`);
            // the door is inside the footprint and the exit is the footprint edge cell on the facing side, in line with the door
            const inside = (c) => c.x >= lot.x && c.x < lot.x + lot.w && c.z >= lot.z && c.z < lot.z + lot.d;
            assert.ok(inside(lot.door) && inside(lot.exit));
            const edge = { north: lot.exit.z === lot.z, south: lot.exit.z === lot.z + lot.d - 1, west: lot.exit.x === lot.x, east: lot.exit.x === lot.x + lot.w - 1 };
            assert.ok(edge[lot.facing], `${lot.id}: exit is not on the ${lot.facing} edge`);
            assert.ok(lot.facing === "north" || lot.facing === "south" ? lot.exit.x === lot.door.x : lot.exit.z === lot.door.z);
            assert.ok(lot.foundation.rect[0] <= lot.x && lot.foundation.rect[2] >= lot.x + lot.w - 1);
        }
    }
});

test("lots: houses are spaced 6-10 apart on average, buildings are not crowded, land stays open", () => {
    let houses = 0;
    for (const role of ROLES) {
        const { lots } = district(role);
        const d = lots.densityReport;
        houses += lots.counts.houses;
        assert.ok(d.footprintFraction < 0.2, `${role}: footprint ${(d.footprintFraction * 100).toFixed(1)}%`);
        assert.ok(d.openFraction > 0.55, `${role}: open ${(d.openFraction * 100).toFixed(1)}%`);
        assert.ok(d.reserveFraction >= 0.15, role);
        assert.ok(d.minGap >= 4, `${role}: min gap ${d.minGap}`);
        if (d.houseMeanNearestGap !== null) {
            assert.ok(d.houseMinGap >= 6, `${role}: houses ${d.houseMinGap} apart`);
            assert.ok(d.houseMeanNearestGap >= 6 && d.houseMeanNearestGap <= (role === "residential" ? 16 : 45), `${role}: mean nearest house gap ${d.houseMeanNearestGap}`);
        }
        assert.ok(d.buildingsPer1000Columns < 2.5, `${role}: ${d.buildingsPer1000Columns.toFixed(2)} buildings per 1000 columns`);
        assert.ok(d.blockEstimate > 6000 && d.blockEstimate < 40000, `${role}: ${d.blockEstimate} blocks`);
    }
    assert.ok(houses >= 40 && houses <= 90, `civilization houses ${houses} outside 40-90`);
});

test("lots: every district keeps its minimum composition and its role showpieces", () => {
    const want = {
        command: { hq_citadel: 1, barracks: 1, hospital: 1, armoury: 1 },
        industrial: { smithy: 3, kiln: 2, workshop: 3, warehouse: 3, quarry_yard: 1 },
        agricultural: { granary: 2, longhouse: 1, mill: 1 },
        commercial: { market_square: 1, market_stall: 8, shop: 4, inn: 1, warehouse: 2 },
        residential: { chapel: 1, school: 1, hospital: 1, well: 3 },
    };
    for (const role of ROLES) {
        for (const [regionSeed, planSeed] of [[3, 11], [5, 7]]) {
            const { lots } = build(role, regionSeed, planSeed);
            assert.ok(lots.composition.ok, `${role}/${regionSeed}: missing ${lots.composition.missing.join(",")} (${JSON.stringify(lots.composition)})`);
            for (const [group, min] of Object.entries(MIN_COMPOSITION)) {
                const have = group === "well" ? (lots.counts.byKind.well ?? 0) : (lots.counts.byGroup[group] ?? 0);
                assert.ok(have >= min, `${role}: ${group} ${have} < ${min}`);
            }
        }
        const { lots } = district(role);
        for (const [kind, min] of Object.entries(want[role])) assert.ok((lots.counts.byKind[kind] ?? 0) >= min, `${role}: ${kind} ${lots.counts.byKind[kind] ?? 0} < ${min}`);
    }
    const homes = ROLES.map((r) => district(r).lots.counts.byGroup.homes ?? 0);
    assert.ok(Math.min(...homes) >= 6, `homes per district ${homes}`);
    assert.ok(homes[4] >= 18 && homes[4] > Math.max(...homes.slice(0, 4)), "residential has the most homes");
    // agriculture: by far the most farmland
    const farmland = ROLES.map((r) => district(r).lots.densityReport.farmlandColumns);
    assert.ok(farmland[2] >= 1200, `agricultural farmland ${farmland[2]}`);
    for (const i of [0, 1, 3, 4]) assert.ok(farmland[2] > farmland[i] * 2, `agricultural farmland ${farmland[2]} vs ${ROLES[i]} ${farmland[i]}`);
    // commercial market and showpiece buildings
    const comm = build("commercial", 3, 11).lots.counts.byKind;
    assert.ok((comm.market_square ?? 0) >= 1 || (comm.market_stall ?? 0) >= 8);
});

test("lots: defence positions ring the wall (guard posts + watchtowers) and face the patrol lane", () => {
    for (const role of ROLES) {
        const { lots, zones } = district(role);
        const posts = lots.lots.filter((l) => l.kind === "guard_post");
        const towers = lots.lots.filter((l) => l.kind === "watchtower");
        assert.ok(posts.length >= 3 && towers.length >= 1, `${role}: ${posts.length} posts ${towers.length} towers`);
        assert.ok(posts.length + towers.length >= MIN_COMPOSITION.defence - (lots.counts.byKind.barracks ?? 0));
        const patrol = new Set(zones.patrol.cells.map(([x, z]) => `${x},${z}`));
        const viaPatrol = [...posts, ...towers].filter((l) => patrol.has(`${l.frontage.x},${l.frontage.z}`)).length;
        assert.ok(viaPatrol >= (posts.length + towers.length) * 0.5, `${role}: only ${viaPatrol} defence lots reach the patrol lane`);
        // spread: not all in one corner (angular spread around the centroid)
        const angles = posts.map((l) => Math.atan2(l.z - zones.hq.z, l.x - zones.hq.x));
        const sectors = new Set(angles.map((a) => Math.floor(((a + Math.PI) / (2 * Math.PI)) * 6)));
        assert.ok(sectors.size >= 3, `${role}: guard posts cover only ${sectors.size} of 6 sectors`);
    }
});

test("deterministic: the same inputs give identical zones and lots; different seeds give different layouts", () => {
    const region = makeRegion({ role: "commercial", index: 4, seed: 9 });
    const { roads, walls, gates } = makeRoadsAndWalls(region);
    const run = (seed) => {
        const zones = zoneDistrict(region, roads, { seed, walls, gates });
        const lots = makeLots(region, zones, roads, { seed });
        return { zones, lots };
    };
    const a = run(21);
    const b = run(21);
    assert.deepEqual(a.lots.lots, b.lots.lots);
    assert.deepEqual(a.zones.zones.map((z) => [z.type, z.cells]), b.zones.zones.map((z) => [z.type, z.cells]));
    assert.deepEqual(a.zones.streets, b.zones.streets);
    const c = run(22);
    assert.notDeepEqual(a.lots.lots.map((l) => [l.x, l.z]), c.lots.lots.map((l) => [l.x, l.z]));
    // key order independent: the hash of a lot list is stable
    assert.equal(JSON.stringify(a.lots.lots), JSON.stringify(b.lots.lots));
});

test("districts look different: composition, zone mix and positions diverge between roles", () => {
    const fingerprints = ROLES.map((role) => {
        const { lots, zones } = district(role);
        const kinds = Object.keys(lots.counts.byKind).sort();
        const mix = {};
        for (const z of zones.zones) mix[z.type] = (mix[z.type] ?? 0) + z.cells.length;
        return { role, kinds, byGroup: lots.counts.byGroup, mix, positions: lots.lots.map((l) => `${l.kind}@${l.x},${l.z}`) };
    });
    const cosine = (a, b) => {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        let dot = 0, na = 0, nb = 0;
        for (const k of keys) { const x = a[k] ?? 0; const y = b[k] ?? 0; dot += x * y; na += x * x; nb += y * y; }
        return dot / Math.sqrt(na * nb);
    };
    for (let i = 0; i < 5; i += 1) {
        for (let j = i + 1; j < 5; j += 1) {
            const g = cosine(fingerprints[i].byGroup, fingerprints[j].byGroup);
            const m = cosine(fingerprints[i].mix, fingerprints[j].mix);
            assert.ok(g < 0.995 && m < 0.9, `${fingerprints[i].role} and ${fingerprints[j].role} are too alike (groups ${g.toFixed(3)}, zones ${m.toFixed(3)})`);
            const shared = fingerprints[i].positions.filter((p) => fingerprints[j].positions.includes(p)).length;
            assert.ok(shared < 4, `${fingerprints[i].role}/${fingerprints[j].role} share ${shared} identical placements`);
        }
    }
    // same role on a different region and seed also differs
    const a = build("residential", 3, 11).lots.lots.map((l) => `${l.kind}@${l.x},${l.z}`);
    const b = build("residential", 4, 12).lots.lots.map((l) => `${l.kind}@${l.x},${l.z}`);
    assert.ok(a.filter((p) => b.includes(p)).length < 5);
});

test("orientation is irregular but reasonable: all four facings occur and most doors face a street within a few blocks", () => {
    const facings = new Set();
    let near = 0;
    let total = 0;
    for (const role of ROLES) {
        for (const lot of district(role).lots.lots) {
            facings.add(lot.facing);
            total += 1;
            if (lot.approach.length <= 8) near += 1;
        }
    }
    assert.equal(facings.size, 4, `facings seen: ${[...facings]}`);
    assert.ok(near / total > 0.8, `${near}/${total} lots reach a road within 8 blocks`);
});

test("regionFromPlan decodes a CivPlan label raster into the region contract", () => {
    const labels = [[0, 3], [2, 4], [0, 1], [2, 4], [0, 4]];
    const plan = { grid: { x0: 100, z0: -40, w: 4, h: 4 }, cell: 4, labels, districts: [{ index: 2, role: "industrial", name: "Ironquarry", outline: [], hq: { x: 110, z: -30 }, bbox: { x0: 112, z0: -40, x1: 127, z1: -25 } }] };
    const region = regionFromPlan(plan, 2);
    // runs: row0 = 0,0,0,2 ; row1 = 2,2,2,0 ; row2 = 2,2,2,2 ; row3 = 0,0,0,0
    assert.equal(region.role, "industrial");
    assert.equal(region.labelAt(112, -39), 2);
    assert.equal(region.labelAt(100, -39), 0);
    assert.equal(region.labelAt(100, -35), 2);
    assert.equal(region.labelAt(112, -35), 0);
    assert.equal(region.labelAt(99, -39), 0);
    assert.equal(region.labelAt(500, 500), 0);
    assert.throws(() => regionFromPlan(plan, 4), /no district 4/);
});

// ------------------------------------------------------------------ adversarial

test("adversarial: a tiny district is handled without errors and without violating any rule", () => {
    const region = makeRegion({ role: "residential", index: 5, seed: 2, r0: 24 });
    const { roads, walls, gates } = makeRoadsAndWalls(region);
    const zones = zoneDistrict(region, roads, { seed: 1, walls, gates });
    const lots = makeLots(region, zones, roads, { seed: 1 });
    assert.equal(zones.degenerate, true);
    assert.ok(lots.lots.length <= 3);
    assert.equal(lots.composition.ok, false, "a 24-radius blob cannot hold the minimum composition and must say so");
    checkLotsStructure({ region, roads, walls, zones, lots });
    // empty region (nothing is ours)
    const empty = { index: 3, role: "agricultural", labelAt: () => 0, outline: [], hq: { x: 0, z: 0 }, bbox: { x0: 0, z0: 0, x1: 40, z1: 40 } };
    const zEmpty = zoneDistrict(empty, [], {});
    assert.equal(zEmpty.degenerate, true);
    assert.equal(makeLots(empty, zEmpty, [], {}).lots.length, 0);
});

test("adversarial: a lake and a river cutting into the district are never built on, and the setback applies to the water", () => {
    const extra = { key: "water", region: { seed: 4, holes: [{ x: 20, z: 35, r: 17 }], river: { x0: -70, x1: 55, z: -40, w: 8 } } };
    const built = build("commercial", 4, 5, extra);
    const { region, lots, zones } = built;
    assert.equal(region.labelAt(20, 35), 0, "the lake really is a hole");
    assert.ok(lots.lots.length >= 25, `only ${lots.lots.length} lots`);
    checkLotsStructure(built);
    for (const lot of lots.lots) {
        for (let z = lot.z - 5; z < lot.z + lot.d + 5; z += 1) for (let x = lot.x - 5; x < lot.x + lot.w + 5; x += 1) {
            if (Math.hypot(x - 20, z - 35) < 17 - 0.01) assert.ok(Math.abs(x - lot.x) + Math.abs(z - lot.z) > 0, "unreachable");
        }
        // closest approach to the lake centre is at least radius + 6 clear blocks (label cells are 4 wide: allow 3)
        let best = Infinity;
        for (const [x, z] of footprintCells(lot)) best = Math.min(best, Math.hypot(x - 20, z - 35));
        assert.ok(best >= 17 + 3, `${lot.id} is only ${best.toFixed(1)} from the lake centre`);
    }
    assert.ok(zones.reserve.fraction >= 0.15, `reserve ${zones.reserve.fraction} notes ${zones.notes.join("; ")}`);
    assert.ok(lots.composition.ok, `composition: ${lots.composition.missing}`);
});

test("adversarial: no roads at all still gives a connected street network (a spine) and valid lots", () => {
    const built = build("industrial", 6, 3, { key: "noroads", rw: { withRoads: false } });
    assert.ok(built.zones.streets.some((s) => s.kind === "spine"), "a spine street must be laid");
    assert.ok(built.zones.notes.some((n) => /no roads/.test(n)));
    assert.ok(built.lots.lots.length >= 25, `${built.lots.lots.length} lots`);
    checkLotsStructure(built);
    const roadSet = roadCells([], allStreets(built.zones, built.lots), 1.6);
    const patrol = new Set(built.zones.patrol.cells.map(([x, z]) => `${x},${z}`));
    for (const lot of built.lots.lots) assert.ok(roadSet.has(`${lot.frontage.x},${lot.frontage.z}`) || patrol.has(`${lot.frontage.x},${lot.frontage.z}`), `${lot.id} frontage`);
});

test("adversarial: no walls, roads outside the district and a missing gate list do not break anything", () => {
    const region = makeRegion({ role: "agricultural", index: 3, seed: 7 });
    const far = [{ id: "far", kind: "arterial", district: 9, width: 5, path: [[900, 900], [950, 950]] }, { id: "bad", kind: "street", path: [] }];
    const zones = zoneDistrict(region, far, { seed: 4 });
    const lots = makeLots(region, zones, far, { seed: 4 });
    assert.ok(zones.streets.some((s) => s.kind === "spine"));
    assert.ok(lots.lots.length >= 25);
    // without walls the setback is measured from the district boundary only: still >= 6
    checkLotsStructure({ region, roads: far.filter((r) => r.path.length > 1), walls: [], zones, lots });
    assert.throws(() => zoneDistrict({ ...region, role: "wizard" }, [], {}), /unknown role/);
});

test("the setback option cannot be weakened below 6 and a larger one is honoured", () => {
    const region = makeRegion({ role: "residential", index: 5, seed: 8 });
    const { roads, walls, gates } = makeRoadsAndWalls(region);
    const weak = zoneDistrict(region, roads, { seed: 2, walls, gates, setback: 1 });
    assert.equal(weak.setback, 6);
    const wide = zoneDistrict(region, roads, { seed: 2, walls, gates, setback: 12 });
    const lots = makeLots(region, wide, roads, { seed: 2 });
    const pts = barrierPoints(region, walls);
    for (const lot of lots.lots.filter((l) => l.zoneType !== "defence")) assert.ok(minBarrierDistance(lot, pts) >= 13 - 1e-9, `${lot.id} violates the 12 setback`);
});

test("sweep: five roles on other district shapes and plan seeds keep every invariant", () => {
    for (const [regionSeed, planSeed] of [[21, 4], [22, 9], [23, 13]]) {
        for (const role of ROLES) {
            const built = build(role, regionSeed, planSeed);
            const label = `${role}/${regionSeed}/${planSeed}`;
            checkLotsStructure(built);
            assert.ok(built.lots.composition.ok, `${label}: missing ${built.lots.composition.missing}`);
            assert.ok(built.zones.reserve.fraction >= 0.15, `${label}: reserve ${built.zones.reserve.fraction}`);
            assert.ok(built.lots.lots.length >= 30, `${label}: ${built.lots.lots.length} lots`);
            assert.ok(built.lots.densityReport.openFraction > 0.55, label);
            for (const lot of built.lots.lots) assert.ok(lot.frontage && lot.approach.length <= 30, `${label}: ${lot.id}`);
        }
    }
});
