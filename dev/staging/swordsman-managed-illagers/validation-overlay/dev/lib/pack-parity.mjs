import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listZip, readZipEntry } from "./zip.mjs";
import { packBindingProblems, packBindings } from "./content-packs.mjs";

/** Compare the actual shipped bytes, including unexpected old files, with the current pack. */
export function archivePackProblems(archive, spec, root, { requireBindings=false }={}) {
    const bytes = readFileSync(archive);
    const entries = listZip(bytes);
    const problems = [];
    for (const pack of spec.packs ?? []) {
        const prefix = `${pack.kind}/${pack.packageDir}/`;
        const expected = new Map();
        function visit(dir, relative = "") {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const name = `${relative}${entry.name}`;
                if (entry.isDirectory()) visit(join(dir, entry.name), `${name}/`);
                else if (!entry.name.endsWith(".log") && !["package.json", "package-lock.json"].includes(entry.name)) {
                    expected.set(name, readFileSync(join(dir, entry.name)));
                }
            }
        }
        visit(join(root, pack.source));
        const seen = new Set();
        for (const entry of entries.filter((item) => item.name.startsWith(prefix) && !item.name.endsWith("/"))) {
            const name = entry.name.slice(prefix.length);
            if (seen.has(name)) problems.push(`duplicate packaged file: ${entry.name}`);
            seen.add(name);
            const content = expected.get(name);
            if (content === undefined) problems.push(`unexpected packaged file: ${entry.name}`);
            else if (!content.equals(readZipEntry(bytes, entry))) problems.push(`stale packaged file: ${entry.name}`);
        }
        for (const name of expected.keys()) {
            if (!seen.has(name)) problems.push(`missing packaged file: ${prefix}${name}`);
        }
    }
    if(requireBindings) {
        const packs=(spec.packs??[]).map(p=>({root:join(root,p.source),kind:p.kind}));
        for(const kind of ["behavior_packs","resource_packs"]) {
            const name=kind==="behavior_packs"?"world_behavior_packs.json":"world_resource_packs.json";
            const found=entries.filter(e=>e.name===name);
            if(found.length!==1){problems.push(`archive must contain ${name} exactly once`);continue;}
            try{problems.push(...packBindingProblems(JSON.parse(readZipEntry(bytes,found[0]).toString("utf8")),packBindings(packs,kind),name));}
            catch(error){problems.push(`invalid archive ${name}: ${String(error)}`);}
        }
    }
    return problems;
}
