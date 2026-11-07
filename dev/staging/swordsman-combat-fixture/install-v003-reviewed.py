"""Root-reviewed v3 upgrade. Run only after root confirms Minecraft fully closed.
Retain installedv2 fixture; add NEWA5/B5 only. No A4/B4 access or DB parsing.
"""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,uuid
STAGE=Path(__file__).resolve().parent;ROOT=STAGE.parents[2]
USERS=Path(os.environ['APPDATA'])/'Minecraft Bedrock/Users'
SHARED=USERS/'Shared/games/com.mojang';PACK_PARENT=SHARED/'development_behavior_packs'
PACK=PACK_PARENT/'CA_ControlledCombatFixture_Nov6';BACKUP_PARENT=SHARED/'codex_pack_backups'
CATALOG=USERS/'16044254735791270272/games/com.mojang/minecraftWorlds'
RECEIPT=ROOT/'dist/swordsman-controlled-fixture-v003-A5B5-install-20261106.json'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
def inventory(root):return{p.relative_to(root).as_posix():sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
def no_links(path):
    for p in [path,*path.parents]:
        if p.exists():assert not(os.lstat(p).st_file_attributes&0x400),p
    if path.is_dir():
        for p in path.rglob('*'):assert not(os.lstat(p).st_file_attributes&0x400),p

def closed():assert subprocess.run(['powershell','-NoProfile','-Command',"if(Get-Process Minecraft* -ErrorAction SilentlyContinue){exit 17}"],capture_output=True).returncode==0,'Minecraft* process present or preflight failed'
def copy_verified(source,target,expected):
    assert not target.exists();target.mkdir(parents=True)
    for relative,value in expected.items():
        p=target/relative;assert p.resolve().is_relative_to(target.resolve()) and not p.exists();p.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source/relative,p);assert sha(p)==value
    assert inventory(target)==expected
closed();assert not RECEIPT.exists();assert all(p.is_dir() for p in [PACK_PARENT,BACKUP_PARENT,CATALOG])
old=json.loads((ROOT/'dist/swordsman-controlled-fixture-v002-install-20261106.json').read_text())['installedPackSha256']
new={r['path'][3:]:r['sha256'] for r in json.loads((STAGE/'pack-hashes.json').read_text())}
assert len(old)==9 and len(new)==13;assert inventory(PACK)==old;assert inventory(STAGE/'BP')==new
manifest=json.loads((STAGE/'BP/manifest.json').read_text());fixture=manifest['header']['uuid'];assert fixture=='fddde689-c92c-43bd-a68a-3cda9f5203d6' and manifest['header']['version']==[0,0,3]
worlds=json.loads((STAGE/'worlds-v003-receipt.json').read_text());assert len(worlds['worlds'])==2
baseline=ROOT/worlds['baseline'];assert baseline.resolve().is_relative_to((ROOT/'dist/backups').resolve());assert inventory(baseline)==worlds['baselineHashes']
entries=[]
for w in worlds['worlds']:
    assert w['worldFolder']==f"CA_Sol1_Path{w['arm']}5_Nov6" and w['arm'] in ['A','B']
    source=ROOT/w['stagedDirectory'];target=CATALOG/w['worldFolder']
    assert source.resolve().is_relative_to(STAGE.resolve()) and target.resolve().parent==CATALOG.resolve() and not target.exists(),'No overwrite of any catalog world'
    assert len(w['hashes'])==13 and inventory(source)==w['hashes']
    binding=json.loads((source/'world_behavior_packs.json').read_text());assert binding==w['behaviorBindings']
    assert len([p for p in binding if p['pack_id']==fixture and p['version']==[0,0,3]])==1
    assert all(v==worlds['baselineHashes'][p] for p,v in w['hashes'].items() if p.startswith('db/'))
    assert len([p for p in w['hashes'] if p.startswith('db/')])==6
    entries.append((source,target,w))
assert worlds['worlds'][1]['behaviorBindings'][1:]==worlds['worlds'][0]['behaviorBindings']
originals=[PACK_PARENT/'CivilizationApocalypse_BP',SHARED/'development_resource_packs/CivilizationApocalypse_RP']
original_before={str(p):inventory(p) for p in originals};assert sum(map(len,original_before.values()))==156,'Expected installed original156 pack files'
sources=[ROOT/'CivilizationApocalypse_BP',ROOT/'CivilizationApocalypse_RP'];source_before={str(p):inventory(p) for p in sources};assert sum(map(len,source_before.values()))==156
for p in [PACK,STAGE/'BP',baseline,*[q for e in entries for q in e[:2]]]:no_links(p)
backup=BACKUP_PARENT/('CA_ControlledCombatFixture-v003-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]);assert backup.resolve().parent==BACKUP_PARENT.resolve() and not backup.exists();no_links(backup)
closed();backup.mkdir();prepared=backup/'prepared-0.0.3';copy_verified(STAGE/'BP',prepared,new)
# These are NEWA5/B5 destinations only; never enumerate, open or writeA4/B4.
for source,target,w in entries:copy_verified(source,target,w['hashes'])
closed();assert inventory(PACK)==old
previous=backup/'previous-0.0.2'
assert PACK.resolve().parent==PACK_PARENT.resolve() and previous.resolve().parent==backup.resolve() and not previous.exists();no_links(PACK);no_links(previous)
PACK.rename(previous);assert inventory(previous)==old
assert prepared.resolve().parent==backup.resolve() and PACK.resolve().parent==PACK_PARENT.resolve() and not PACK.exists();no_links(prepared);no_links(PACK)
prepared.rename(PACK);assert inventory(PACK)==new
results=[]
for source,target,w in entries:
    assert inventory(source)==w['hashes'] and inventory(target)==w['hashes']
    results.append({'arm':w['arm'],'destination':str(target),'verifiedFiles':13,'behaviorBindings':w['behaviorBindings'],'sha256':w['hashes']})
assert inventory(baseline)==worlds['baselineHashes'] and inventory(STAGE/'BP')==new
assert all(inventory(Path(p))==v for p,v in original_before.items()) and all(inventory(Path(p))==v for p,v in source_before.items())
receipt={'status':'isolatedv003 fixture and NEWA5/B5 installed; Minecraft NOT launched','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backup':str(previous),'retainedOldFixtureFiles':9,'fixtureVersion':[0,0,3],'installedPack':str(PACK),'installedPackSha256':new,'worlds':results,'baselineLevelSha256':worlds['baselineLevelSha256'],'originalInstalledPacksUnchanged':{p:len(v) for p,v in original_before.items()},'originalSourcePacksUnchanged':{p:len(v) for p,v in source_before.items()},'A4B4':'Not read or modified; old invalid/control trials retained','limits':'Closed filecopy/SHA only, no DB parsing. Cage/camera/commands/nativehealth/gearevidence/combat not accepted by installer.'}
RECEIPT.write_text(json.dumps(receipt,indent=2),encoding='utf8',newline='\n')
print('Verified13fixture +26NEWworldfiles; old9fixture retained outside scanned dirs; installed/source156 unchanged; noA4/B4 access; no launch.')
print(RECEIPT)
