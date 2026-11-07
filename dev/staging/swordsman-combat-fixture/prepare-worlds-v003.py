"""Prepare two NEW uninstalled copies from one explicitly closed baseline."""
from pathlib import Path
import ast,hashlib,json,shutil,struct
STAGE=Path(__file__).resolve().parent
ROOT=STAGE.parents[2]
BASE=ROOT/'dist/backups/swordsman-sol1-peaceful-appearance-baseline-20261106'
EXPECTED='7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
assert BASE.resolve().is_relative_to((ROOT/'dist/backups').resolve())
assert sha(BASE/'level.dat')==EXPECTED,'Closed baseline differs: do not guess'
files=sorted(p for p in BASE.rglob('*') if p.is_file())
assert len(files)==13,len(files)
assert all(not p.is_symlink() for p in BASE.rglob('*'))
baseline={p.relative_to(BASE).as_posix():sha(p) for p in files}
# Pure NBT parser definitions, without executing its separate backup-report code.
tree=ast.parse((ROOT/'dev/prototypes/closed-journal-audit/audit.py').read_text())
module=ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))],type_ignores=[])
scope={'struct':struct};exec(compile(module,'closed-level-parser','exec'),scope)
NBT=scope['NBT']
fixture=json.loads((STAGE/'BP/manifest.json').read_text())['header']
owner={'pack_id':'fd04cb50-dddc-4ebe-83fc-5b5375819bcb','version':[1,0,0]}
probe={'pack_id':'c8644dda-e2b4-46cc-b2cb-5b72f5d972c9','version':[0,0,1]}
shared={'pack_id':fixture['uuid'],'version':fixture['version']}
results=[]
for arm in ['A','B']:
    target=STAGE/f'worlds/CA_Sol1_Path{arm}5_Nov6'
    assert target.resolve().is_relative_to(STAGE.resolve()) and not target.exists(),'Never overwrite existing staged worlds'
    target.mkdir(parents=True)
    for source in files:
        destination=target/source.relative_to(BASE);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
        assert sha(destination)==baseline[source.relative_to(BASE).as_posix()]
    name=f'CA Sol1 Path {arm}5 Nov6'
    raw=(target/'level.dat').read_bytes();version,length=struct.unpack_from('<II',raw);payload=raw[8:]
    assert length==len(payload)
    before=NBT(payload).root()[1]
    marker=b'\x08\x09\x00LevelName';assert payload.count(marker)==1
    start=payload.index(marker)+len(marker);oldLength=struct.unpack_from('<H',payload,start)[0];end=start+2+oldLength
    encoded=name.encode('utf8');changed=payload[:start]+struct.pack('<H',len(encoded))+encoded+payload[end:]
    after=NBT(changed).root()[1];assert after['LevelName']==name
    after['LevelName']=before['LevelName'];assert after==before,'Only root LevelName may differ'
    (target/'level.dat').write_bytes(struct.pack('<II',version,len(changed))+changed)
    (target/'levelname.txt').write_text(name,encoding='utf8',newline='\n')
    bindings=([probe] if arm=='B' else [])+[shared,owner]
    (target/'world_behavior_packs.json').write_text(json.dumps(bindings,indent=2),encoding='utf8',newline='\n')
    hashes={p.relative_to(target).as_posix():sha(p) for p in sorted(target.rglob('*')) if p.is_file()}
    changedFiles=[p for p in hashes if hashes[p]!=baseline[p]]
    assert set(changedFiles)=={'level.dat','levelname.txt','world_behavior_packs.json'}
    results.append({'arm':arm,'name':name,'stagedDirectory':str(target.relative_to(ROOT)).replace('\\','/'),'worldFolder':target.name,'allFilesCopiedAndVerified':len(files),'changedFiles':changedFiles,'behaviorBindings':bindings,'hashes':hashes})
assert all(sha(BASE/p)==v for p,v in baseline.items()),'Closed source must remain unchanged'
receipt={'scope':'UNINSTALLED copies only; no live world or database reads; DB/source bytes identical in A/B','baseline':str(BASE.relative_to(ROOT)).replace('\\','/'),'baselineLevelSha256':EXPECTED,'baselineHashes':baseline,'fixturePackId':fixture['uuid'],'worlds':results}
(STAGE/'worlds-v003-receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf8',newline='\n')
print('Prepared A5/B5 staging copies,13 files each; all6DB files SHA-identical to the closed baseline. Nothing installed.')
