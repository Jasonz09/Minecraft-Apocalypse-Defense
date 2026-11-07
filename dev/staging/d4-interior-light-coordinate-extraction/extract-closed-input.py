"""Run ONLY in root-authorized CLOSED Minecraft window; closed backup WAL only."""
import ast, hashlib, json
from pathlib import Path
root=Path(__file__).resolve().parents[3]
backup=(root/'dist/backups/d1-diagnostics-pinned-20261106').resolve()
receipt_path='dist/native-d1-diagnostics-pinned-backup-hashes-20261106.json'
receipt=json.loads((root/receipt_path).read_text(encoding='utf-8-sig'))
assert Path(receipt['backup']).resolve()==backup and backup.is_relative_to((root/'dist/backups').resolve())
assert len(receipt['files'])==receipt['fileCount']==15
actual=sorted(p.relative_to(backup).as_posix() for p in backup.rglob('*') if p.is_file())
expected=sorted(Path(r['path']).as_posix() for r in receipt['files'])
assert actual==expected, 'Closed inventory changed'
for row in receipt['files']:
    assert (backup/row['path']).resolve().is_relative_to(backup)
parser=root/'dev/prototypes/closed-journal-audit/audit.py'
tree=ast.parse(parser.read_text(encoding='utf-8'));scope={}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.ClassDef))],type_ignores=[]),str(parser),'exec'),scope)
helper=root/'dist/audit-leaf-complete14-20261106.py'
tree=ast.parse(helper.read_text(encoding='utf-8'))
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]),'reviewed-closed-snapshot-helper','exec'),globals())
seq,props=snapshot(receipt_path)
assert isinstance(props.get('civ:kingdom'),str)
kept={k:v for k,v in props.items() if k=='civ:kingdom' or k.startswith(('civ:plan:','civ:jobs'))}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
out={'scope':'Hashverified15-file CLOSED backup CRC-WAL snapshot only; no liveDB/SST/block/entity reads','sequence':seq,'backup':str(backup),'levelDatSha256':sha(backup/'level.dat'),'backupReceipt':receipt_path,'backupReceiptSha256':sha(root/receipt_path),'parserSha256':sha(parser),'snapshotHelperSha256':sha(helper),'allBackup15FilesHashVerified':True,'inventoryExact':True,'properties':kept}
target=root/'dist/d4-interior-light-closed-input-20261106.json'
target.write_text(json.dumps(out,indent=2),encoding='utf-8')
print('Closed saved-source input:',target,'sequence',seq,'properties',len(kept))
