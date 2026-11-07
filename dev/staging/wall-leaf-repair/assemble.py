from pathlib import Path
import hashlib,json
STAGE=Path(__file__).resolve().parent
ROOT=STAGE.parents[2]
TARGET=STAGE/'proposed/CivilizationApocalypse_BP/scripts'
def write(path,text):
    assert path.resolve().is_relative_to(STAGE.resolve())
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(text,encoding='utf8',newline='\n')
core=(STAGE/'leaf-trim.mjs').read_text()
core=core.replace('../../../CivilizationApocalypse_BP/scripts/structures/terrain.js','../structures/terrain.js').replace('../../../CivilizationApocalypse_BP/scripts/civ/districtplan.js','./districtplan.js').replace('../../../CivilizationApocalypse_BP/scripts/civ/planstore.js','./planstore.js')
write(TARGET/'civ/wallLeafTrim.js',core)
runtime=(STAGE/'wall-leaf-repair.mjs').read_text().replace('./leaf-trim.mjs','./wallLeafTrim.js').replace('../../../CivilizationApocalypse_BP/scripts/civ/wallleafpreview.js','./wallleafpreview.js').replace('../../../CivilizationApocalypse_BP/scripts/civ/planstore.js','./planstore.js')
write(TARGET/'civ/wallLeafRepair.js',runtime)
civ=(ROOT/'CivilizationApocalypse_BP/scripts/commands/civ.js').read_text()
anchor='import { formatWallLeafPreview, previewWallLeavesSteps } from "../civ/wallleafpreview.js";'
assert anchor in civ
civ=civ.replace(anchor,anchor+'\nimport { POLICY as LEAF_TRIM_POLICY, LEAF_TRIM_MASONRY_IDS } from "../civ/wallLeafTrim.js";\nimport { createWallLeafSourceGuard, wallLeafRepairSteps, createWallLeafBlockAdapter } from "../civ/wallLeafRepair.js";',1)
anchor='        const leaves=/^leafpreview'
assert anchor in civ
civ=civ.replace(anchor,'        const leafRepair=/^leafrepair district=([1-5]) policy=wall-leaves-trim-v1(?: (confirm))?$/.exec(event.message.trim());\n        if(leafRepair){void repairSavedWallLeaves(kingdomStore,event,Number(leafRepair[1]),!!leafRepair[2]);return;}\n'+anchor,1)
civ=civ.replace('[walls district=N | leafpreview district=N [page=P] |','[walls district=N | leafpreview district=N [page=P] | leafrepair district=N policy=wall-leaves-trim-v1 [confirm] |',1)
anchor='/** Read every loaded final-wall target and classify the complete bounded tree list.'
assert anchor in civ
civ=civ.replace(anchor,(STAGE/'command-handler.txt').read_text()+anchor,1)
write(TARGET/'commands/civ.js',civ)
starter=(ROOT/'CivilizationApocalypse_BP/scripts/sim/starter.js').read_text()
anchor='    for (const key of [...keys].sort()) {'
assert anchor in starter
starter=starter.replace(anchor,anchor+'\n        if(key.startsWith("civ:wall_leaf_trim:")){out.keep.push(key);continue;}',1)
anchor='    const militaryKeys ='
assert anchor in starter
starter=starter.replace(anchor,'    if((world.keys??[]).some(key=>key.startsWith("civ:wall_leaf_trim:")))problems.push("wall-leaf maintenance receipts remain; retain every pending, completed or unknown receipt and reconcile release-copy export separately before arming");\n'+anchor,1)
write(TARGET/'sim/starter.js',starter)
receipt={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest().upper() for p in [ROOT/'CivilizationApocalypse_BP/scripts/commands/civ.js',ROOT/'CivilizationApocalypse_BP/scripts/sim/starter.js',ROOT/'dev/prototypes/wall-leaf-trim/leaf-trim.mjs']}
write(STAGE/'assembly-source-hashes.json',json.dumps(receipt,indent=2))
print('Assembled proposed files under staging only.')
