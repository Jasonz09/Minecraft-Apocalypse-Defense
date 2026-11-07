from pathlib import Path
import ast,hashlib,json
root=Path(__file__).resolve().parents[3]
receipt='dist/native161-city-census-cadence1-backup-hashes-20261106.json'
r=json.loads((root/receipt).read_text(encoding='utf-8-sig'));backup=Path(r['backup']).resolve();assert backup.is_relative_to((root/'dist/backups').resolve())
expected={Path(x['path']).as_posix():x for x in r['files']};actual={p.relative_to(backup).as_posix():p for p in backup.rglob('*') if p.is_file()};assert len(actual)==len(expected)==15 and set(actual)==set(expected)
for k,v in expected.items():assert actual[k].stat().st_size==v['bytes'] and hashlib.sha256(actual[k].read_bytes()).hexdigest().upper()==v['sha256']
parser=root/'dev/prototypes/closed-journal-audit/audit.py';helper=root/'dist/audit-leaf-complete14-20261106.py';tree=ast.parse(parser.read_text(encoding='utf-8'));scope={};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef,ast.ClassDef))],type_ignores=[]),str(parser),'exec'),scope)
tree=ast.parse(helper.read_text(encoding='utf-8'));exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]),str(helper),'exec'),globals())
sequence,props=snapshot(receipt);assert sequence==383540
keep={k:v for k,v in props.items() if k=='civ:kingdom' or k.startswith(('civ:plan:','civ:jobs'))};assert len(keep)==36
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest().upper()
out={'scope':'Hashverified15file CLOSEDbackup WALCRC only; no liveDB/SST/currentphysical read','sequence':sequence,'backupReceipt':receipt,'backupReceiptSha256':sha(root/receipt),'levelDatSha256':sha(backup/'level.dat'),'parserSha256':sha(parser),'helperSha256':sha(helper),'properties':keep}
(root/'dev/staging/chapel-source-provenance/closed-input.json').write_text(json.dumps(out,indent=2)+'\n',encoding='utf-8');print('Verified15closedfiles;CRC383540;36sourceproperties extracted.')
