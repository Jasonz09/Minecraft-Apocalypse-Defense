import "../../lib/civharness.mjs";
import {readFileSync} from "node:fs";
const original=new URL("../../../CivilizationApocalypse_BP/scripts/civ/",import.meta.url);
function data(name,extra={}){let source=readFileSync(new URL(name,import.meta.url),"utf8");source=source.replace(/from "([^"\n]+)"/g,(all,s)=>`from "${extra[s]??new URL(s,new URL(name,original)).href}"`);return "data:text/javascript;base64,"+Buffer.from(source).toString("base64");}
const coreUrl=data("wallLeafTrim.js");
export const core=await import(coreUrl);
export const controller=await import(data("wallLeafRepair.js",{"./wallLeafTrim.js":coreUrl}));
