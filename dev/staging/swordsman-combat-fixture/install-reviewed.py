"""Install ONLY the root-reviewed isolated fixture and NEW A4/B4 copied worlds."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
STAGE=Path(__file__).resolve().parent;ROOT=STAGE.parents[2]
ROAMING=Path(os.environ['APPDATA'])/'Minecraft Bedrock/Users'
SHARED=ROAMING/'Shared/games/com.mojang';CATALOG=ROAMING/'16044254735791270272/games/com.mojang/minecraftWorlds'
PACK_PARENT=SHARED/'development_behavior_packs';PACK=PACK_PARENT/'CA_ControlledCombatFixture_Nov6'
RECEIPT=ROOT/'dist/swordsman-controlled-fixture-A4B4-install-20261106.json'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
def no_links(path):
    for part in [path,*path.parents]:
        if part.exists():assert not (os.lstat(part).st_file_attributes&0x400),f'Reparse/link target refused: {part}'
def closed():
    result=subprocess.run(['powershell','-NoProfile','-Command',"if(Get-Process -Name 'Minecraft.Windows','Minecraft' -ErrorAction SilentlyContinue){exit 17}"],capture_output=True)
    assert result.returncode==0,'Minecraft process present or closed preflight failed'
def inventory(path):return {p.relative_to(path).as_posix():sha(p) for p in sorted(path.rglob('*')) if p.is_file()}
closed();assert PACK_PARENT.is_dir() and CATALOG.is_dir();assert not RECEIPT.exists()
pack_hashes=json.loads((STAGE/'pack-hashes.json').read_text());worlds=json.loads((STAGE/'worlds-receipt.json').read_text())
assert len(pack_hashes)==5 and len(worlds['worlds'])==2
assert all(r['path'].startswith('BP/') for r in pack_hashes)
sources=[(STAGE/'BP',PACK,{r['path'][3:]:r['sha256'] for r in pack_hashes})]
for w in worlds['worlds']:
    sources.append((ROOT/w['stagedDirectory'],CATALOG/w['worldFolder'],w['hashes']))
# Validate ALL source files, identities, bindings and destinations before any copy.
for source,destination,expected in sources:
    assert source.resolve().is_relative_to(STAGE.resolve())
    assert destination.resolve().parent in [PACK_PARENT.resolve(),CATALOG.resolve()]
    assert not destination.exists(),f'Never overwrite destination: {destination}'
    no_links(source);no_links(destination)
    assert inventory(source)==expected,'Staged source differs from reviewed receipt'
    assert all(not (os.lstat(p).st_file_attributes&0x400) for p in source.rglob('*'))
manifest=json.loads((STAGE/'BP/manifest.json').read_text());assert manifest['header']['uuid']=='fddde689-c92c-43bd-a68a-3cda9f5203d6'
assert manifest['modules'][0]['type']=='data'
assert worlds['worlds'][1]['behaviorBindings'][1:]==worlds['worlds'][0]['behaviorBindings']
for w in worlds['worlds']:
    assert json.loads((ROOT/w['stagedDirectory']/'world_behavior_packs.json').read_text())==w['behaviorBindings']
    for p,v in worlds['baselineHashes'].items():
        if p.startswith('db/'):assert w['hashes'][p]==v
originals=[PACK_PARENT/'CivilizationApocalypse_BP',SHARED/'development_resource_packs/CivilizationApocalypse_RP']
original_before={str(p):inventory(p) for p in originals}
closed()
results=[]
for source,destination,expected in sources:
    destination.mkdir()
    for relative,value in expected.items():
        target=destination/relative
        assert target.resolve().is_relative_to(destination.resolve()) and not target.exists()
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/relative,target)
        assert sha(target)==value
    after=inventory(destination);assert after==expected
    results.append({'source':str(source),'destination':str(destination),'verifiedFiles':len(after),'sha256':after})
assert all(inventory(source)==expected for source,_,expected in sources),'Source changed during install'
assert all(inventory(Path(p))==before for p,before in original_before.items()),'Original installed BP/RP changed'
receipt={'status':'installed verified; Minecraft NOT launched','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'closedProcessPreflight':True,
'fixturePackId':manifest['header']['uuid'],'results':results,'originalInstalledPacksUnchanged':{p:len(v) for p,v in original_before.items()},'baselineLevelSha256':worlds['baselineLevelSha256'],
'worldBindingReceipt':str(STAGE/'worlds-receipt.json'),'limits':'Native floor/staging health/equipment command acceptance/combat NOT tested. Operator exact-count preconditions required.'}
RECEIPT.write_text(json.dumps(receipt,indent=2),encoding='utf8',newline='\n')
print('Installed verified5 fixture files and26 new world files; originals unchanged; Minecraft NOT launched.')
print(RECEIPT)
