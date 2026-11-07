from pathlib import Path
import hashlib,json,shutil
stage=Path(__file__).resolve().parent;root=stage.parents[2];source=root/'CivilizationApocalypse_BP/scripts'
for relative,expected in json.loads((stage/'source-hashes.json').read_text()).items():
 assert hashlib.sha256((source/relative).read_bytes()).hexdigest().upper()==expected,'Source changed; explicitly rebase/re-review rather than applying stale proposal'
shutil.copytree(source,stage/'typecheck/scripts',dirs_exist_ok=True)
shutil.copytree(stage/'proposed/CivilizationApocalypse_BP/scripts',stage/'typecheck/scripts',dirs_exist_ok=True)
print('Rebuilt isolated review/test overlay only; active source unchanged.')
