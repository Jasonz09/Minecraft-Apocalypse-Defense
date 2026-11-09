"""Read-only evidence from an explicitly closed backup; never grants fixture trust.

Reuses the project's pinned CRC-WAL/NBT reader definitions, without executing that
prototype's old hardcoded-world audit. No engine DB is opened and no world is changed.
"""
from pathlib import Path
import argparse
import ast
import hashlib
import json
import stat
import struct

ROOT = Path(__file__).resolve().parents[3]
PARSER = ROOT / 'dev/prototypes/closed-journal-audit/audit.py'
PARSER_SHA = 'C4DC2BB4292E4845E308B5ACE3B0982C52BA054A26092A8B0CD95BF36F276257'
MAIN_UUID = 'fd04cb50-dddc-4ebe-83fc-5b5375819bcb'
LIMITS = {'files': 10000, 'fileBytes': 128 * 1024 * 1024, 'totalBytes': 1024 * 1024 * 1024,
          'scoreboardBytes': 65536, 'dynamicBytes': 1024 * 1024, 'treeNodes': 10000, 'treeDepth': 64}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            digest.update(block)
    return digest.hexdigest().upper()


def parser_definitions():
    if sha(PARSER) != PARSER_SHA:
        raise ValueError('pinned CRC/NBT parser changed; independent review required')
    module = ast.parse(PARSER.read_text(encoding='utf-8'))
    allowed = (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef)
    namespace = {}
    exec(compile(ast.Module(body=[node for node in module.body if isinstance(node, allowed)],
                            type_ignores=[]), str(PARSER), 'exec'), namespace)
    return namespace


def inventory(backup):
    result = {}
    total = 0
    for path in sorted(backup.rglob('*')):
        info = path.lstat()
        if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise ValueError('backup contains a link/reparse point')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('backup contains a nonregular file')
        total += info.st_size
        if len(result) >= LIMITS['files'] or info.st_size > LIMITS['fileBytes'] or total > LIMITS['totalBytes']:
            raise ValueError('closed backup exceeds audit bounds')
        result[path.relative_to(backup).as_posix()] = {'bytes': info.st_size, 'sha256': sha(path)}
    return result


def tree_rows(tree):
    """Bounded evidence paths; names/integers are observations, not identity guesses."""
    rows = []
    stack = [('$', tree, 0)]
    while stack:
        path, value, depth = stack.pop()
        if depth > LIMITS['treeDepth'] or len(rows) >= LIMITS['treeNodes']:
            raise ValueError('NBT evidence tree exceeds bounds')
        rows.append((path, value))
        if isinstance(value, dict):
            stack.extend((path + '[' + json.dumps(k) + ']', v, depth + 1) for k, v in value.items())
        elif isinstance(value, list):
            stack.extend((path + '[' + str(i) + ']', v, depth + 1) for i, v in enumerate(value))
    return rows


def strict_records(raw, parser):
    # The inherited reader checks record CRC/fragment ordering. Add an explicit
    # padding check so ignored short tails cannot masquerade as a closed record.
    for start in range(0, len(raw), 32768):
        block = raw[start:start + 32768]
        cursor = 0
        while cursor + 7 <= len(block):
            crc, size, kind = struct.unpack_from('<IHB', block, cursor)
            if not crc and not size and not kind:
                break
            cursor += 7 + size
            if cursor > len(block):
                raise ValueError('incomplete closed WAL physical record')
        if any(block[cursor:]):
            raise ValueError('nonzero unparsed closed WAL padding/tail')
    return parser['records'](raw)


def audit_backup(backup, plan, allowed_root=None):
    backup = Path(backup).resolve()
    if allowed_root is not None and not backup.is_relative_to(Path(allowed_root).resolve()):
        raise ValueError('only an explicitly named dist/backups copy may be audited')
    if not backup.is_dir():
        raise ValueError('closed backup directory missing')
    for field in ('label', 'objective', 'displayName', 'participant'):
        if not isinstance(plan.get(field), str) or not plan[field] or len(plan[field]) > 128:
            raise ValueError('plan identity field invalid: ' + field)
    if plan['objective'] != 'ca_fresh_owner' or plan.get('score') != 0:
        raise ValueError('plan objective/score differs from runtime contract')
    before = inventory(backup)
    bindings = {}
    for name in ('world_behavior_packs.json', 'world_resource_packs.json'):
        if name not in before:
            raise ValueError('both explicit empty pack-binding files are required')
        bindings[name] = json.loads((backup / name).read_text(encoding='utf-8-sig'))
        if bindings[name] != []:
            raise ValueError('vanilla source has bound packs; preserve and refuse')
    if 'level.dat' not in before or not any(name.startswith('db/') for name in before):
        raise ValueError('level.dat or closed DB files missing')
    parser = parser_definitions()
    level_raw = (backup / 'level.dat').read_bytes()
    if len(level_raw) < 12 or struct.unpack_from('<i', level_raw, 4)[0] != len(level_raw) - 8:
        raise ValueError('level.dat exact payload length differs')
    _, level = parser['NBT'](level_raw[8:]).root()
    if level.get('LevelName') != plan['label']:
        raise ValueError('level name differs from witnessed preparation plan')
    latest = None
    wal_files = []
    history = []
    for name in sorted(before):
        if not name.startswith('db/') or not name.endswith('.log'):
            continue
        wal_files.append(name)
        for record in strict_records((backup / name).read_bytes(), parser):
            for sequence, key, value in parser['batches'](record):
                if key == b'scoreboard':
                    if latest is not None and sequence == latest[0] and value != latest[1]:
                        raise ValueError('conflicting same-sequence scoreboard snapshots')
                    if latest is None or sequence > latest[0]:
                        latest = (sequence, value)
                if key == b'DynamicProperties' and value is not None:
                    if len(value) > LIMITS['dynamicBytes']:
                        raise ValueError('dynamic property snapshot exceeds bound')
                    _, properties = parser['NBT'](value).root()
                    for path, node in tree_rows(properties):
                        if isinstance(node, dict):
                            if any(k == MAIN_UUID or k.startswith(('civ:', 'civ_', 'civpop:', 'civbirth:')) for k in node):
                                history.append({'sequence': sequence, 'path': path})
    if history:
        raise ValueError('main owner/history namespace appears in closed WAL; preserve and refuse')
    if latest is None or latest[1] is None or len(latest[1]) > LIMITS['scoreboardBytes']:
        raise ValueError('bounded current scoreboard snapshot missing from closed WAL')
    _, scoreboard = parser['NBT'](latest[1]).root()
    rows = tree_rows(scoreboard)
    matches = {field: [path for path, value in rows if value == plan[field]]
               for field in ('objective', 'displayName', 'participant')}
    if not all(matches.values()):
        raise ValueError('planned marker strings absent from current scoreboard evidence')
    after = inventory(backup)
    if before != after:
        raise ValueError('backup changed during read-only audit')
    return {'scope': 'Read-only pinned closed-copy CRC-WAL/NBT evidence ONLY; no trust grant or engine DB access',
            'decision': 'EVIDENCE_ONLY_REQUIRES_ROOT_REVIEW', 'backup': str(backup),
            'files': before, 'filesStableDuringAudit': True, 'packBindings': bindings,
            'levelDatSha256': before['level.dat']['sha256'], 'levelName': level['LevelName'],
            'parserSha256': PARSER_SHA, 'walFiles': wal_files,
            'mainOwnerHistorySeenInWal': False,
            'sstFilesNotDecoded': [name for name in before if name.endswith(('.ldb', '.sst'))],
            'scoreboard': {'sequence': latest[0], 'rawSha256': hashlib.sha256(latest[1]).hexdigest().upper(),
                           'tree': scoreboard, 'plannedStringPaths': matches},
            'runtimeParticipantIdentityAndExactScoreReviewed': False,
            'operatorKnownNewVanillaAttested': False, 'compiledTrust': None,
            'limitations': ['WAL absence is not proof of SST/entity/owner-history absence.',
                            'Runtime FakePlayer ID, exactly-one objective/participant and score0 need review against actual NBT and native identity.',
                            'Root must witness genuine new vanilla creation and closed-copy chain; no retrospective blessing.',
                            'No private trust module or world property is written by this tool.']}


def write_evidence(output, backup, report):
    output = Path(output).resolve()
    evidence_root = Path(__file__).parent.resolve() / 'native-evidence'
    if not output.is_relative_to(evidence_root) or output.suffix != '.json' or output.is_relative_to(Path(backup).resolve()):
        raise ValueError('output must be a new JSON inside this stage/native-evidence and outside source backup')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite proposals, pinned manifests or an earlier evidence receipt.
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')


def main():
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument('--backup', required=True)
    command.add_argument('--plan', required=True)
    command.add_argument('--output', required=True)
    args = command.parse_args()
    report = audit_backup(args.backup, json.loads(Path(args.plan).read_text(encoding='utf-8-sig')),
                          ROOT / 'dist/backups')
    write_evidence(args.output, args.backup, report)
    print(json.dumps({key: report[key] for key in ('decision', 'levelName', 'filesStableDuringAudit', 'compiledTrust')}))


if __name__ == '__main__':
    main()
