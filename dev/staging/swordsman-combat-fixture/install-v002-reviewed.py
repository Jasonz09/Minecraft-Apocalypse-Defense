"""Reviewed isolated fixture0.0.2 upgrade. Closed-file copies/SHA only; no DB parsing."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,uuid,re
STAGE=Path(__file__).resolve().parent;ROOT=STAGE.parents[2]
SHARED=Path(os.environ['APPDATA'])/'Minecraft Bedrock/Users/Shared/games/com.mojang'
PACK_PARENT=SHARED/'development_behavior_packs';PACK=PACK_PARENT/'CA_ControlledCombatFixture_Nov6'
CATALOG=Path(os.environ['APPDATA'])/'Minecraft Bedrock/Users/16044254735791270272/games/com.mojang/minecraftWorlds'
BACKUP_PARENT=SHARED/'codex_pack_backups';FIXTURE='fddde689-c92c-43bd-a68a-3cda9f5203d6'
RECEIPT=ROOT/'dist/swordsman-controlled-fixture-v002-install-20261106.json'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
def inventory(root):return{p.relative_to(root).as_posix():sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
def no_links(path):
    for p in [path,*path.parents]:
        if p.exists():assert not(os.lstat(p).st_file_attributes&0x400),p
    if path.is_dir():
        for p in path.rglob('*'):assert not(os.lstat(p).st_file_attributes&0x400),p

def closed():assert subprocess.run(['powershell','-NoProfile','-Command',"if(Get-Process -Name 'Minecraft.Windows','Minecraft' -ErrorAction SilentlyContinue){exit 17}"],capture_output=True).returncode==0,'Minecraft must remain closed'
def copy_verified(source,target,expected):
    assert not target.exists();target.mkdir(parents=True)
    for relative,value in expected.items():
        out=target/relative;assert out.resolve().is_relative_to(target.resolve()) and not out.exists();out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source/relative,out);assert sha(out)==value
    assert inventory(target)==expected
closed();assert not RECEIPT.exists();assert PACK_PARENT.is_dir() and CATALOG.is_dir() and BACKUP_PARENT.is_dir()
old=json.loads((ROOT/'dist/swordsman-controlled-fixture-height-correction-20261106.json').read_text())['installedHashes']
new={r['path'][3:]:r['sha256'] for r in json.loads((STAGE/'pack-hashes.json').read_text())}
assert len(old)==5 and len(new)==9;assert inventory(PACK)==old;assert inventory(STAGE/'BP')==new
manifest=json.loads((STAGE/'BP/manifest.json').read_text());assert manifest['header']['uuid']==FIXTURE and manifest['header']['version']==[0,0,2]
assert [m['type'] for m in manifest['modules']]==['data','script']
initial=json.loads((ROOT/'dist/swordsman-controlled-fixture-A4B4-install-20261106.json').read_text())
worlds=initial['results'][1:];assert len(worlds)==2
prepared_bindings=[]
for w in worlds:
    world=Path(w['destination']);assert world.resolve().parent==CATALOG.resolve();assert len(w['sha256'])==13;assert inventory(world)==w['sha256'],'World opened/changed; abort before any mutation'
    raw=(world/'world_behavior_packs.json').read_bytes();before=json.loads(raw);selected=[i for i,b in enumerate(before) if b['pack_id']==FIXTURE];assert len(selected)==1 and before[selected[0]]['version']==[0,0,1]
    # Change EXACTLY one final version digit, preserving all other binding bytes.
    pattern=rb'("pack_id"\s*:\s*"'+FIXTURE.encode()+rb'"\s*,\s*"version"\s*:\s*\[\s*0\s*,\s*0\s*,\s*)1(\s*\])'
    matches=list(re.finditer(pattern,raw));assert len(matches)==1
    m=matches[0];digit=m.end(1);assert raw[digit:digit+1]==b'1'
    updated=raw[:digit]+b'2'+raw[digit+1:];after=json.loads(updated)
    expected=json.loads(raw);expected[selected[0]]['version']=[0,0,2];assert after==expected
    assert updated[:digit]+b'1'+updated[digit+1:]==raw
    prepared_bindings.append((world,raw,updated,before,after))
originals=[PACK_PARENT/'CivilizationApocalypse_BP',SHARED/'development_resource_packs/CivilizationApocalypse_RP']
original_before={str(p):inventory(p) for p in originals};assert sum(map(len,original_before.values()))==152
sources=[ROOT/'CivilizationApocalypse_BP',ROOT/'CivilizationApocalypse_RP'];source_before={str(p):inventory(p) for p in sources};assert sum(map(len,source_before.values()))==156
for p in [PACK,STAGE/'BP',*map(lambda w:Path(w['destination']),worlds)]:no_links(p)
backup=BACKUP_PARENT/('CA_ControlledCombatFixture-v002-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8])
assert backup.resolve().parent==BACKUP_PARENT.resolve() and not backup.exists();no_links(backup)
closed();backup.mkdir();prepared=backup/'prepared-0.0.2';copy_verified(STAGE/'BP',prepared,new)
# Retain all26 world files BEFORE either installed binding is changed.
for w in worlds:copy_verified(Path(w['destination']),backup/'worlds-v001'/Path(w['destination']).name,w['sha256'])
assert inventory(PACK)==old
for w in worlds:assert inventory(Path(w['destination']))==w['sha256']
closed()
previous=backup/'previous-0.0.1'
# Both full-directory moves have exact checked source/destination scope, stay on
# volumeC, reject links/existing targets, and never recursively delete anything.
assert PACK.resolve().parent==PACK_PARENT.resolve() and previous.resolve().parent==backup.resolve() and not previous.exists();no_links(PACK);no_links(previous)
PACK.rename(previous);assert inventory(previous)==old
assert prepared.resolve().parent==backup.resolve() and PACK.resolve().parent==PACK_PARENT.resolve() and not PACK.exists();no_links(prepared);no_links(PACK)
prepared.rename(PACK);assert inventory(PACK)==new
world_results=[]
for w,(world,raw,updated,before,after) in zip(worlds,prepared_bindings):
    target=world/'world_behavior_packs.json';assert target.resolve().parent==world.resolve();assert target.read_bytes()==raw
    target.write_bytes(updated);post=inventory(world)
    assert len(post)==13
    for name,value in w['sha256'].items():
        if name!='world_behavior_packs.json':assert post[name]==value,name
    db=[name for name in post if name.startswith('db/')];assert len(db)==6 and all(post[n]==w['sha256'][n] for n in db)
    assert json.loads(target.read_bytes())==after
    world_results.append({'destination':str(world),'verifiedFiles':13,'onlyChangedFile':'world_behavior_packs.json','exactByteDifference':'one fixture version digit1to2; all other bytes unchanged','bindingsBefore':before,'bindingsAfter':after,'sha256':post})
assert inventory(STAGE/'BP')==new and inventory(PACK)==new
assert all(inventory(Path(p))==v for p,v in original_before.items())
assert all(inventory(Path(p))==v for p,v in source_before.items())
receipt={'status':'isolated fixture0.0.2 installed and two unopened world bindings updated; Minecraft NOT launched','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'closedPreflight':True,'backupRoot':str(backup),'retainedPreviousFixtureFiles':5,'retainedOriginalWorldFiles':26,'fixturePackId':FIXTURE,'version':[0,0,2],'installedPack':str(PACK),'installedPackSha256':new,'worlds':world_results,'originalInstalledPacksUnchanged':{p:len(v) for p,v in original_before.items()},'originalSourcePacksUnchanged':{p:len(v) for p,v in source_before.items()},'limitations':'No DB parsing/opening; closed-file copy/SHA only. No native health/equippable/clear-command/floor/combat acceptance proof.'}
RECEIPT.write_text(json.dumps(receipt,indent=2),encoding='utf8',newline='\n')
print('INSTALLED9/9 fixtureSHA; backedup5+26 outside scanned parents; updated exactly1bindingdigit/arm.26fresh worldSHA verified, DB unchanged; installed152/source156 unchanged. No launch.')
print(RECEIPT)
