from pathlib import Path
import shutil,json
STAGE=Path(__file__).resolve().parent
ROOT=STAGE.parents[2]
target=STAGE/'typecheck/scripts'
shutil.copytree(ROOT/'CivilizationApocalypse_BP/scripts',target,dirs_exist_ok=True)
shutil.copytree(STAGE/'proposed/CivilizationApocalypse_BP/scripts',target,dirs_exist_ok=True)
(STAGE/'tsconfig.json').write_text(json.dumps({'extends':'../../../tsconfig.json','include':['typecheck/scripts/**/*.js']},indent=2))
print('Prepared isolated strict typecheck overlay; active sources untouched.')
