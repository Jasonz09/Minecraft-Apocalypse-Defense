from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,uuid
STAGE=Path(__file__).resolve().parent;ROOT=STAGE.parents[2]
SHARED=Path(os.environ['APPDATA'])/'Minecraft Bedrock/Users/Shared/games/com.mojang'
PACK=SHARED/'development_behavior_packs/CA_ControlledCombatFixture_Nov6'
BACKUP_ROOT=SHARED/'codex_pack_backups';RECEIPT=ROOT/'dist/swordsman-controlled-fixture-height-correction-20261106.json'
assert BACKUP_ROOT.is_dir() and not RECEIPT.exists()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
def inventory(root):return{p.relative_to(root).as_posix():sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
def closed():assert subprocess.run(['powershell','-NoProfile','-Command',"if(Get-Process -Name 'Minecraft.Windows','Minecraft' -ErrorAction SilentlyContinue){exit 17}"],capture_output=True).returncode==0,'Minecraft must remain closed'
def nolink(path):
    for p in [path,*path.parents]:
        if p.exists():assert not(os.lstat(p).st_file_attributes&0x400),p
closed();installed=json.loads((ROOT/'dist/swordsman-controlled-fixture-A4B4-install-20261106.json').read_text())
old=installed['results'][0]['sha256'];assert len(old)==5 and inventory(PACK)==old
new={r['path'][3:]:r['sha256'] for r in json.loads((STAGE/'pack-hashes.json').read_text())};assert inventory(STAGE/'BP')==new
changed=[p for p in new if new[p]!=old[p]];target='functions/ca_combat_fixture/internal/spawn_body.mcfunction';assert changed==[target]
originals=[SHARED/'development_behavior_packs/CivilizationApocalypse_BP',SHARED/'development_resource_packs/CivilizationApocalypse_RP'];before={str(p):inventory(p) for p in originals}
for world in installed['results'][1:]:assert inventory(Path(world['destination']))==world['sha256']
backup=BACKUP_ROOT/('CA_ControlledCombatFixture_Nov6-height0-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8])
assert backup.resolve().is_relative_to(BACKUP_ROOT.resolve()) and not backup.exists();nolink(backup);nolink(PACK)
closed();backup.mkdir()
for relative,value in old.items():
    copy=backup/relative;assert copy.resolve().is_relative_to(backup.resolve());copy.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(PACK/relative,copy);assert sha(copy)==value
assert inventory(backup)==old
# Overwrite exactly one recognized, backed-up function after its last old-SHA check.
assert sha(PACK/target)==old[target];assert sha(STAGE/'BP'/target)==new[target]
(PACK/target).write_bytes((STAGE/'BP'/target).read_bytes());assert inventory(PACK)==new
assert all(inventory(Path(p))==v for p,v in before.items())
for world in installed['results'][1:]:assert inventory(Path(world['destination']))==world['sha256']
receipt={'status':'one isolated fixture function updated; Minecraft NOT launched','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'closedPreflight':True,'backup':str(backup),'backedUpFiles':5,'changedFile':target,'oldSha256':old[target],'newSha256':new[target],'installedHashes':new,'originalPacksUnchanged':{p:len(v) for p,v in before.items()},'A4B4VerifiedUnchangedFiles':26,'nativePrecondition':'Guard Y66-67, staging groundY67, feetY68-69 and body/head clearance must be checked before spawn; other heights abort.'}
RECEIPT.write_text(json.dumps(receipt,indent=2),encoding='utf8',newline='\n')
print('Backed up5 isolated files outside scanned parents; updated exactly1 spawn function to~40 ~2 ~;5SHAverified;26worldfiles/original152packfilesunchanged. No launch.')
print('OLD',old[target]);print('NEW',new[target]);print(RECEIPT)
