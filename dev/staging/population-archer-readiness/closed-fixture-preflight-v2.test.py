"""Synthetic closed-copy tests only; no actual Minecraft provenance is asserted."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('closed-fixture-preflight-v2.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PLAN = {'label': 'Synthetic only', 'objective': 'ca_fresh_owner', 'displayName': 'synthetic_nonce',
        'participant': 'synthetic_fake', 'score': 0}


def string(value):
    raw = value.encode('utf-8')
    return struct.pack('<H', len(raw)) + raw


def nbt(values):
    body = b''
    for key, value in values.items():
        if isinstance(value, str):
            body += b'\x08' + string(key) + string(value)
        else:
            body += b'\x03' + string(key) + struct.pack('<i', value)
    return b'\x0a\0\0' + body + b'\0'


def varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def wal(entries, sequence=1):
    body = struct.pack('<QI', sequence, len(entries))
    for key, value in entries:
        body += (b'\0' if value is None else b'\1') + varint(len(key)) + key
        if value is not None:
            body += varint(len(value)) + value
    crc = module.parser_definitions()['crc32c'](b'\1' + body)
    masked = (((crc >> 15) | (crc << 17)) + 0xa282ead8) & 0xffffffff
    return struct.pack('<IHB', masked, len(body), 1) + body


class ClosedFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'db').mkdir()
        for name in ['world_behavior_packs.json', 'world_resource_packs.json']:
            (self.root / name).write_text('[]', encoding='utf-8')
        level = nbt({'LevelName': PLAN['label']})
        (self.root / 'level.dat').write_bytes(struct.pack('<ii', 10, len(level)) + level)
        self.scoreboard = nbt({'objective': PLAN['objective'], 'displayName': PLAN['displayName'],
                               'participant': PLAN['participant'], 'ID': 17, 'Score': 0})
        self.log = self.root / 'db/000003.log'
        self.log.write_bytes(wal([(b'scoreboard', self.scoreboard)]))

    def tearDown(self):
        self.temp.cleanup()

    def audit(self):
        return module.audit_backup(self.root, PLAN)

    def test_evidence_only_pins_exact_files_and_never_grants_trust(self):
        before = module.inventory(self.root)
        result = self.audit()
        self.assertIsNone(result['compiledTrust'])
        self.assertFalse(result['operatorKnownNewVanillaAttested'])
        self.assertFalse(result['runtimeParticipantIdentityAndExactScoreReviewed'])
        self.assertTrue(result['filesStableDuringAudit'])
        self.assertEqual(result['files'], before)
        self.assertEqual(module.inventory(self.root), before)
        self.assertTrue(all(result['scoreboard']['plannedStringPaths'].values()))

    def test_nonempty_or_missing_bindings_refuse(self):
        (self.root / 'world_behavior_packs.json').write_text('[{"pack_id":"main"}]', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'bound packs'):
            self.audit()
        (self.root / 'world_behavior_packs.json').unlink()
        with self.assertRaisesRegex(ValueError, 'binding files'):
            self.audit()

    def test_crc_corruption_refuses(self):
        raw = bytearray(self.log.read_bytes())
        raw[-1] ^= 1
        self.log.write_bytes(raw)
        with self.assertRaisesRegex(AssertionError, 'CRC'):
            self.audit()

    def test_short_nonzero_tail_refuses(self):
        self.log.write_bytes(self.log.read_bytes() + b'bad')
        with self.assertRaisesRegex(ValueError, 'tail'):
            self.audit()

    def test_historical_main_namespace_even_later_deleted_refuses(self):
        history = nbt({module.MAIN_UUID: 'past-owner'})
        self.log.write_bytes(wal([(b'DynamicProperties', history), (b'DynamicProperties', None),
                                 (b'scoreboard', self.scoreboard)]))
        with self.assertRaisesRegex(ValueError, 'history namespace'):
            self.audit()

    def test_wrong_level_name_refuses(self):
        altered = dict(PLAN, label='wrong')
        with self.assertRaisesRegex(ValueError, 'level name'):
            module.audit_backup(self.root, altered)

    def test_missing_marker_refuses(self):
        self.log.write_bytes(wal([(b'scoreboard', nbt({'objective': 'other'}))]))
        with self.assertRaisesRegex(ValueError, 'marker strings absent'):
            self.audit()

    def test_conflicting_same_sequence_scoreboard_refuses(self):
        self.log.write_bytes(wal([(b'scoreboard', self.scoreboard)], 10)
                             + wal([(b'scoreboard', nbt({'other': 'conflict'}))], 10))
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            self.audit()

    def test_sst_and_nonzero_score_are_not_silently_certified(self):
        (self.root / 'db/000001.ldb').write_bytes(b'not decoded')
        self.log.write_bytes(wal([(b'scoreboard', nbt({'objective': PLAN['objective'], 'displayName': PLAN['displayName'],
                                                     'participant': PLAN['participant'], 'Score': 42}))]))
        result = self.audit()
        self.assertEqual(result['sstFilesNotDecoded'], ['db/000001.ldb'])
        self.assertEqual(result['scoreboard']['tree']['Score'], 42)
        self.assertFalse(result['runtimeParticipantIdentityAndExactScoreReviewed'])
        self.assertIsNone(result['compiledTrust'])

    def test_changed_backup_refuses(self):
        before = module.inventory(self.root)
        changed = dict(before, extra={'bytes': 0, 'sha256': 'changed'})
        with patch.object(module, 'inventory', side_effect=[before, changed]):
            with self.assertRaisesRegex(ValueError, 'changed during'):
                self.audit()

    def test_cli_scope_cannot_target_live_directory(self):
        with self.assertRaisesRegex(ValueError, 'dist/backups'):
            module.audit_backup(self.root, PLAN, module.ROOT / 'dist/backups')

    def test_output_cannot_overwrite_proposals_manifests_or_source(self):
        for output in [Path(__file__).with_name('PROMOTION-HASHES.json'), self.root / 'new.json',
                       Path(__file__).parent / 'proposed/CivilizationApocalypse_BP/scripts/integration/freshFixtureTrust.js']:
            with self.assertRaisesRegex(ValueError, 'new JSON'):
                module.write_evidence(output, self.root, {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
