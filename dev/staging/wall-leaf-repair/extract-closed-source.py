from pathlib import Path
import ast, hashlib, json, struct
ROOT=Path(__file__).resolve().parents[3]
STAGE=Path(__file__).resolve().parent
BACKUP=ROOT/'dist/backups/corrected-d4-leaf-preview14-20261106'
assert BACKUP.resolve().is_relative_to((ROOT/'dist/backups').resolve())
expected=json.loads((ROOT/'dist/corrected-d4-leaf-preview14-backup-hashes.json').read_text(encoding='utf-8-sig'))
print('Receipt shape:',type(expected).__name__)
if isinstance(expected,dict): expected=expected.get('files',expected.get('hashes'))
assert isinstance(expected,list)
for row in expected:
    name=row.get('path',row.get('relativePath',row.get('file')))
    sha=row.get('sha256',row.get('hash'))
    assert name and sha
    candidate=BACKUP/name
    assert candidate.resolve().is_relative_to(BACKUP.resolve())
    assert hashlib.sha256(candidate.read_bytes()).hexdigest().upper()==sha.upper(),name
assert hashlib.sha256((BACKUP/'level.dat').read_bytes()).hexdigest().upper()=='0109A6B32F47536BFB53261DA771ECE8F62E47BF1ABAF1DAFB55AF43E71C1018'
# Reuse pure parser definitions only; never execute its separate backup/report code.
tree=ast.parse((ROOT/'dev/prototypes/closed-journal-audit/audit.py').read_text())
module=ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))],type_ignores=[])
scope={'struct':struct};exec(compile(module,'closed-source-parser','exec'),scope)
latest=None
for file in sorted((BACKUP/'db').glob('*.log')):
    for record in scope['records'](file.read_bytes()):
        for seq,key,value in scope['batches'](record):
            if key==b'DynamicProperties' and (latest is None or seq>latest[0]):latest=(seq,value)
assert latest,'No closed WAL snapshot found; do not guess source provenance'
_,dynamic=scope['NBT'](latest[1]).root()
props=dynamic['fd04cb50-dddc-4ebe-83fc-5b5375819bcb']
kept={k:v for k,v in props.items() if k=='civ:kingdom' or k.startswith(('civ:plan:','civ:jobs:'))}
output={'scope':'Closed CRC-verified WAL snapshot; saved sources only, no physical block/entity proof','sequence':latest[0],
    'backupLevelSha256':'0109A6B32F47536BFB53261DA771ECE8F62E47BF1ABAF1DAFB55AF43E71C1018','properties':kept}
(STAGE/'closed-source-fixture.json').write_text(json.dumps(output,indent=2),encoding='utf8')
print('Extracted',len(kept),'saved source properties from closed WAL sequence',latest[0])
