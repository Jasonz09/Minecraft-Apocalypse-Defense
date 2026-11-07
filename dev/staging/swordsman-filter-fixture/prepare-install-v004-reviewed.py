"""Default is READ-ONLY planning. --apply requires root review and Minecraft closed.

New disposable worlds only. Never use the played catalog A5/B5 as a baseline.
No LevelDB parsing, entity changes, launches or implicit installation.
"""
from pathlib import Path
import argparse, ast, datetime, hashlib, json, os, shutil, struct, subprocess, uuid

STAGE = Path(__file__).resolve().parent
ROOT = STAGE.parents[2]
USERS = Path(os.environ['APPDATA']) / 'Minecraft Bedrock/Users'
SHARED = USERS / 'Shared/games/com.mojang'
PACK_PARENT = SHARED / 'development_behavior_packs'
PACK = PACK_PARENT / 'CA_ControlledCombatFixture_Nov6'
BACKUPS = SHARED / 'codex_pack_backups'
CATALOG = USERS / '16044254735791270272/games/com.mojang/minecraftWorlds'
BASE = ROOT / 'dist/backups/swordsman-sol1-peaceful-appearance-baseline-20261106'
WORLD_RECEIPT = ROOT / 'dev/staging/swordsman-combat-fixture/worlds-v003-receipt.json'
OLD_INSTALL = ROOT / 'dist/swordsman-controlled-fixture-v003-A5B5-install-20261106.json'
FIXTURE_UUID = 'fddde689-c92c-43bd-a68a-3cda9f5203d6'
OWNER = {'pack_id': 'fd04cb50-dddc-4ebe-83fc-5b5375819bcb', 'version': [1, 0, 0]}
RP_UUID = 'e634c636-7b98-49f7-81cd-13483bfa3f9f'
EXPECTED_LEVEL = '7B0E743374390D57A63134CDE2997EBB9D4E8EC2DDE6555C8E5BF404FCB2F412'

def sha_bytes(data):
    return hashlib.sha256(data).hexdigest().upper()

def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def no_links(path):
    for item in [path, *path.parents]:
        if item.exists():
            assert not (os.lstat(item).st_file_attributes & 0x400), str(item)
    if path.is_dir():
        for item in path.rglob('*'):
            assert not (os.lstat(item).st_file_attributes & 0x400), str(item)

def inventory(path):
    no_links(path)
    assert path.is_dir(), str(path)
    return {p.relative_to(path).as_posix(): sha_bytes(p.read_bytes())
            for p in sorted(path.rglob('*')) if p.is_file()}

def closed():
    result = subprocess.run(['powershell', '-NoProfile', '-Command',
        'if(Get-Process Minecraft* -ErrorAction SilentlyContinue){exit 17}'], capture_output=True)
    assert result.returncode == 0, 'Minecraft process present or closure check failed'

def nbt_parser():
    # Only reviewed parser definitions; no report code or database access.
    source = ROOT / 'dev/prototypes/closed-journal-audit/audit.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
    scope = {'struct': struct}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), scope)
    return scope['NBT']

def rename_level(raw, name, NBT):
    # Same raw-string substitution and semantic check used by reviewed v003 utility.
    version, length = struct.unpack_from('<II', raw)
    payload = raw[8:]
    assert length == len(payload)
    before = NBT(payload).root()[1]
    marker = b'\x08\x09\x00LevelName'
    assert payload.count(marker) == 1
    start = payload.index(marker) + len(marker)
    prior_length = struct.unpack_from('<H', payload, start)[0]
    encoded = name.encode('utf-8')
    assert len(encoded) <= 65535
    changed = payload[:start] + struct.pack('<H', len(encoded)) + encoded + payload[start + 2 + prior_length:]
    after = NBT(changed).root()[1]
    assert after['LevelName'] == name
    after['LevelName'] = before['LevelName']
    assert after == before, 'Only root LevelName may differ'
    return struct.pack('<II', version, len(changed)) + changed

def protect_old_bindings():
    # Only small binding files, never played A5/B5 DBs or catalog entity health.
    result = {}
    for folder in ['CA_Sol1_PathA5_Nov6', 'CA_Sol1_PathB5_Nov6']:
        for name in ['world_behavior_packs.json', 'world_resource_packs.json']:
            p = CATALOG / folder / name
            no_links(p)
            assert p.is_file(), str(p)
            result[str(p)] = sha_bytes(p.read_bytes())
    return result

def preflight(freeze_path):
    for path in [STAGE / 'BP', BASE, PACK, BACKUPS, CATALOG]:
        no_links(path)
    assert BASE.resolve().is_relative_to((ROOT / 'dist/backups').resolve())
    prior = load(WORLD_RECEIPT)
    assert (ROOT / prior['baseline']).resolve() == BASE.resolve()
    baseline = inventory(BASE)
    assert len(baseline) == 13 and baseline == prior['baselineHashes']
    assert baseline['level.dat'] == prior['baselineLevelSha256'] == EXPECTED_LEVEL
    # Verify untouched staged A5/B5 without using either as a world source.
    for w in prior['worlds']:
        source = ROOT / w['stagedDirectory']
        assert source.resolve().is_relative_to((ROOT / 'dev/staging/swordsman-combat-fixture/worlds').resolve())
        assert inventory(source) == w['hashes']
    package = load(STAGE / 'pack-hashes.json')
    new = inventory(STAGE / 'BP')
    assert len(new) == 27 and new == package['files']
    manifest = load(STAGE / 'BP/manifest.json')
    assert manifest['header']['uuid'] == FIXTURE_UUID and manifest['header']['version'] == [0, 0, 4]
    assert manifest['modules'] == [
        {'type': 'data', 'uuid': '2a4843cb-005d-47f0-a9be-1cb1dcf31cce', 'version': [0, 0, 4]},
        {'type': 'script', 'language': 'javascript', 'uuid': '16040681-1573-4243-a6cd-fe4b57e28f6e',
         'version': [0, 0, 4], 'entry': 'scripts/main.js'}]
    assert manifest['dependencies'] == [
        {'uuid': OWNER['pack_id'], 'version': OWNER['version']},
        {'module_name': '@minecraft/server', 'version': '2.7.0'}]
    old = load(OLD_INSTALL)['installedPackSha256']
    assert len(old) == 13 and inventory(PACK) == old
    assert load(PACK / 'manifest.json')['header']['version'] == [0, 0, 3]
    # A conflicting duplicate fixture UUID anywhere scanned refuses installation.
    for name in ['behavior_packs', 'resource_packs', 'development_behavior_packs', 'development_resource_packs']:
        parent = SHARED / name
        if parent.exists():
            no_links(parent)
            for p in parent.glob('*/manifest.json'):
                if load(p).get('header', {}).get('uuid') == FIXTURE_UUID:
                    assert p.parent.resolve() == PACK.resolve(), 'Duplicate fixture UUID in scanned pack parents'
    freeze = load(freeze_path)
    rows = freeze['files'] if isinstance(freeze, dict) else freeze
    expected = {r['path'].replace('\\', '/'): r['sha256'] for r in rows}
    original_paths = {'CivilizationApocalypse_BP': PACK_PARENT / 'CivilizationApocalypse_BP',
        'CivilizationApocalypse_RP': SHARED / 'development_resource_packs/CivilizationApocalypse_RP'}
    original = {name: inventory(path) for name, path in original_paths.items()}
    flattened = {name + '/' + p: value for name, values in original.items() for p, value in values.items()}
    assert flattened == expected and len(flattened) == 160, 'Installed production packs must match chosen reviewed freeze'
    bp = load(original_paths['CivilizationApocalypse_BP'] / 'manifest.json')
    rp = load(original_paths['CivilizationApocalypse_RP'] / 'manifest.json')
    assert bp['header']['uuid'] == OWNER['pack_id'] and bp['header']['version'] == OWNER['version']
    assert rp['header']['uuid'] == RP_UUID and rp['header']['version'] == [1, 0, 0]
    assert [d for d in bp['dependencies'] if 'uuid' in d] == [{'uuid': RP_UUID, 'version': [1, 0, 0]}]
    source_before = {name: inventory(ROOT / name) for name in original_paths}
    assert load(BASE / 'world_behavior_packs.json') == [OWNER]
    assert load(BASE / 'world_resource_packs.json') == [{'pack_id': RP_UUID, 'version': [1, 0, 0]}]
    NBT = nbt_parser()
    worlds = []
    for profile, label in [('pillager', 'Pillager'), ('vindicator', 'Vindicator')]:
        folder = 'CA_' + label + 'Filter_Nov6'
        name = 'CA ' + label + ' Filter Nov6'
        target = CATALOG / folder
        assert target.resolve().parent == CATALOG.resolve() and not target.exists(), 'Never overwrite any world'
        no_links(target)
        data = {p: (BASE / p).read_bytes() for p in baseline}
        data['level.dat'] = rename_level(data['level.dat'], name, NBT)
        data['levelname.txt'] = name.encode('utf-8')
        binding = [{'pack_id': FIXTURE_UUID, 'version': [0, 0, 4]}, OWNER]
        data['world_behavior_packs.json'] = json.dumps(binding, indent=2).encode('utf-8')
        hashes = {p: sha_bytes(b) for p, b in data.items()}
        changed = sorted(p for p in hashes if hashes[p] != baseline[p])
        assert changed == ['level.dat', 'levelname.txt', 'world_behavior_packs.json']
        assert all(hashes[p] == baseline[p] for p in baseline if p.startswith('db/'))
        worlds.append({'profile': profile, 'name': name, 'destination': str(target), 'folder': folder,
            'changedFiles': changed, 'hashes': hashes, 'bindings': binding, 'data': data})
    return {'baseline': baseline, 'old': old, 'new': new, 'worlds': worlds,
        'original': original, 'originalPaths': original_paths, 'source': source_before,
        'oldBindings': protect_old_bindings()}

def describe(plan, freeze):
    return {'state': 'READ-ONLY PLAN; no install or world writes', 'productionFreeze': str(freeze),
        'baseline': str(BASE), 'baselineHashes': plan['baseline'], 'baselineFiles': 13,
        'existingFixtureVersion': [0, 0, 3], 'proposedFixtureVersion': [0, 0, 4],
        'fixtureUUID': FIXTURE_UUID, 'sameUUIDUpgrade': True, 'newPackHashes': plan['new'],
        'oldFixtureMustBeRetainedOutsideScans': True,
        'worlds': [{k: v for k, v in w.items() if k != 'data'} for w in plan['worlds']],
        'oldA5B5Bindings': plan['oldBindings'],
        'healthLimit': 'Baseline is the exact previously observed full-HP30 original guard source. File identity alone does not verify current entity health; native original-ID/HP30/canonical1-type1-tag1 checks are mandatory before each trial. No heal, summon or guard teleport.',
        'scope': 'Controlled namespace-tag FILTER fixture only, not real siege-owner or casualty acceptance. Owner-window chronology remains mandatory.'}

def write_verified(data, target):
    assert not target.exists()
    target.mkdir()
    for name, raw in data.items():
        p = target / name
        assert p.resolve().is_relative_to(target.resolve())
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('xb') as out:
            out.write(raw)
    assert inventory(target) == {p: sha_bytes(b) for p, b in data.items()}

def apply(plan, freeze):
    closed()
    nonce = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    work = BACKUPS / ('CA_ControlledFilterFixture-v004-' + nonce)
    assert work.resolve().parent == BACKUPS.resolve() and not work.exists()
    no_links(work)
    work.mkdir()
    # Stage every output outside scanned pack/world parents before moving originals.
    prepared = work / 'prepared-0.0.4'
    write_verified({p: (STAGE / 'BP' / p).read_bytes() for p in plan['new']}, prepared)
    assert inventory(prepared) == plan['new']
    for w in plan['worlds']:
        write_verified(w['data'], work / w['folder'])
    (work / 'operation-plan.json').write_text(json.dumps(describe(plan, freeze), indent=2), encoding='utf-8')
    closed()
    assert inventory(PACK) == plan['old'] and inventory(STAGE / 'BP') == plan['new']
    assert inventory(BASE) == plan['baseline'] and protect_old_bindings() == plan['oldBindings']
    for name, path in plan['originalPaths'].items():
        assert inventory(path) == plan['original'][name]
        assert inventory(ROOT / name) == plan['source'][name]
    assert all(not Path(w['destination']).exists() for w in plan['worlds'])
    assert inventory(prepared) == plan['new']
    for w in plan['worlds']:
        assert inventory(work / w['folder']) == w['hashes']
    previous = work / 'previous-0.0.3'
    # All checked absolute paths remain in explicitly named target/backup parents.
    assert PACK.resolve().parent == PACK_PARENT.resolve() and previous.resolve().parent == work.resolve()
    no_links(PACK)
    no_links(previous)
    no_links(prepared)
    PACK.rename(previous)
    assert inventory(previous) == plan['old'] and not PACK.exists()
    try:
        prepared.rename(PACK)
    except BaseException:
        if not PACK.exists():
            previous.rename(PACK)
        raise
    assert inventory(PACK) == plan['new']
    for w in plan['worlds']:
        closed()
        target = Path(w['destination'])
        assert target.resolve().parent == CATALOG.resolve() and not target.exists()
        no_links(target)
        assert inventory(work / w['folder']) == w['hashes']
        (work / w['folder']).rename(target)
        assert inventory(target) == w['hashes']
    assert inventory(BASE) == plan['baseline'] and protect_old_bindings() == plan['oldBindings']
    for name, path in plan['originalPaths'].items():
        assert inventory(path) == plan['original'][name]
        assert inventory(ROOT / name) == plan['source'][name]
    result = describe(plan, freeze)
    result.update(state='Installed v004 and TWO NEW disposable worlds; no Minecraft launch/native acceptance',
        utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), retainedPreviousFixture=str(previous),
        installedFixture=str(PACK), operationDirectory=str(work))
    receipt = ROOT / 'dist/swordsman-filter-v004-install-20261106.json'
    with receipt.open('x', encoding='utf-8') as out:
        json.dump(result, out, indent=2)
    return result

if __name__ == '__main__':
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--apply', action='store_true', help='Only after explicit root review; requires closed Minecraft')
    args.add_argument('--production-freeze', default='dist/civilian-travel-trace-pack-hashes-20261106.json')
    options = args.parse_args()
    freeze = (ROOT / options.production_freeze).resolve()
    assert freeze.is_relative_to((ROOT / 'dist').resolve()) and freeze.is_file()
    if options.apply:
        assert not (ROOT / 'dist/swordsman-filter-v004-install-20261106.json').exists()
        closed()
    checked = preflight(freeze)
    print(json.dumps(apply(checked, freeze) if options.apply else describe(checked, freeze), indent=2))
