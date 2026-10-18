import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const gates = [
    { name: "manifest + packaging", argv: ["dev/validate-manifest.mjs"] },
    { name: "typecheck against @minecraft/server 2.7.0", argv: ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"] },
    { name: "offline unit tests", argv: ["--test", "dev/test/*.test.mjs"] },
    { name: "headless end-to-end kingdom run", argv: ["dev/e2e-kingdom.mjs"] },
    { name: "starter-world template spec", argv: ["dev/validate-template.mjs"] },
];

const results = [];
for (const gate of gates) {
    const run = spawnSync(process.execPath, gate.argv, { cwd: projectRoot, stdio: "inherit" });
    results.push({ name: gate.name, code: run.status });
}

console.log("\n=================== gate summary ===================");
for (const result of results) {
    console.log(`${result.code === 0 ? "PASS" : "FAIL"}  ${result.name}  (exit ${String(result.code)})`);
}
const failed = results.filter((result) => result.code !== 0);
console.log(failed.length === 0 ? "all gates green" : `${String(failed.length)} gate(s) failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
