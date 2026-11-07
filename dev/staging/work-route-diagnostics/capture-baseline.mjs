import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const {fixture}=await import('../../lib/civilian-route-preview-fixture.mjs');
const baseURL=new URL('../../../CivilizationApocalypse_BP/scripts/people/workRoutePreview.js',import.meta.url);
let code=readFileSync(new URL('./frozen-workRoutePreview.js',import.meta.url),'utf8');code=code.replace(/from\s+(['"])([^'"]+)\1/g,(_,quote,s)=>`from ${quote}${new URL(s,baseURL).href}${quote}`);
const before=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const tests=readFileSync(new URL('./diagnostics.test.mjs',import.meta.url),'utf8');const start=tests.indexOf('function run(module,mode){'),end=tests.indexOf('\nfunction withoutAddedDiagnostics',start);
const run=new Function('fixture','assert',tests.slice(start,end)+';return run;')(fixture,assert),cases={};
for(const mode of ['safe','body','unloaded','headroom','endpoint','source']){const result=structuredClone(run(before,mode));delete result.view.samples;cases[mode]=result;}
const baseline=readFileSync(new URL('./frozen-workRoutePreview.js',import.meta.url));writeFileSync(new URL('./proposed-dev/fixtures/civilian-loaded-route-diagnostics-before.json',import.meta.url),JSON.stringify({scope:'Frozen pre-diagnostic actual algorithm observations/read trace; explicit synthetic source-fixture seam, not native route proof',sourceSha256:createHash('sha256').update(baseline).digest('hex').toUpperCase(),limits:before.LOADED_ROUTE_LIMITS,cases},null,2)+'\n');console.log('Captured six bounded actual-baseline observations/read traces.');
