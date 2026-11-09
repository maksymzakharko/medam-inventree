"""Safety checks use real archives/files, with no daemon, database or network."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('checkpoint', ROOT / 'infrastructure/scripts/checkpoint.py')
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


class CheckpointSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='medam-checkpoint-test-')
        self.folder = Path(self.temporary.name) / '20261108T000000Z'
        self.folder.mkdir()
        for name in checkpoint.PARTS:
            if name.endswith('.tar.gz'):
                self.archive(name)
            else:
                (self.folder / name).write_text('fixture\n')
        images = {name: {'id': 'sha256:' + 'a' * 64} for name in (
            'api', 'edge', 'app-db', 'inventree-db', 'inventree-cache', 'inventree-server')}
        (self.folder / 'image-lock.json').write_text(json.dumps(images))
        (self.folder / 'manifest.json').write_text(json.dumps({
            'format': 2, 'parts': sorted(checkpoint.PARTS), 'postgresMajor': 17,
            'inventreeVersion': '1.7.0', 'inventreeApiVersion': 570,
        }))
        self.sums()

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, archive, name='fixture.txt', kind=tarfile.REGTYPE):
        with tarfile.open(self.folder / archive, 'w:gz') as file:
            member = tarfile.TarInfo(name)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = 7
                file.addfile(member, io.BytesIO(b'fixture'))
            else:
                member.linkname = '/tmp/forbidden-target'
                file.addfile(member)

    def sums(self):
        (self.folder / 'SHA256SUMS').write_text(''.join(
            hashlib.sha256((self.folder / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in sorted(checkpoint.PARTS | {'manifest.json'})))

    def test_extracts_valid_set_and_refuses_existing_target_without_overwrite(self):
        destination = Path(self.temporary.name) / 'new-target'
        checkpoint.extract(self.folder, destination)
        self.assertEqual((destination / 'fixture.txt').read_text(), 'fixture')
        self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
        self.assertEqual((destination / 'fixture.txt').stat().st_mode & 0o777, 0o644)
        self.assertEqual((destination / 'secrets/fixture.txt').stat().st_mode & 0o777, 0o600)
        self.assertEqual((destination / 'secrets').stat().st_mode & 0o777, 0o700)
        self.assertEqual((destination / 'recovery-evidence/original-config/fixture.txt').stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            checkpoint.extract(self.folder, destination)
        self.assertEqual((destination / 'fixture.txt').read_text(), 'fixture')

    def test_changed_dump_is_rejected(self):
        (self.folder / 'app.dump').write_text('changed dump')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
            checkpoint.validate(self.folder)

    def test_missing_component_is_rejected(self):
        (self.folder / 'inventree.dump').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or unsafe'):
            checkpoint.validate(self.folder)

    def test_partial_directory_is_rejected(self):
        target = self.folder.with_suffix('.partial')
        self.folder.rename(target)
        with self.assertRaisesRegex(ValueError, 'complete checkpoint'):
            checkpoint.validate(target)

    def test_authenticated_but_unsafe_archive_members_are_rejected_before_extraction(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE),
                           ('fifo', tarfile.FIFOTYPE)]:
            with self.subTest(name=name):
                self.archive('source.tar.gz', name, kind)
                self.sums()
                target = Path(self.temporary.name) / 'refused'
                with self.assertRaisesRegex(ValueError, 'unsafe path'):
                    checkpoint.extract(self.folder, target)
                self.assertFalse(target.exists())

    def test_symlink_checkpoint_part_is_rejected(self):
        dump = self.folder / 'app.dump'
        dump.unlink()
        dump.symlink_to(self.folder / 'inventree.dump')
        with self.assertRaisesRegex(ValueError, 'unsafe checkpoint part'):
            checkpoint.validate(self.folder)

    def test_restore_refuses_existing_target_before_docker(self):
        destination = Path(self.temporary.name) / 'existing'
        destination.mkdir()
        sentinel = destination / 'sentinel'
        sentinel.write_text('preserve me')
        result = subprocess.run(['bash', str(ROOT / 'infrastructure/scripts/restore.sh'),
            '/not-a-checkpoint', '--target', str(destination), '--project', 'medam-restore-test01'],
            capture_output=True, text=True, env={**os.environ, 'PATH': '/usr/bin:/bin'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nieistniejącym', result.stderr)
        self.assertEqual(sentinel.read_text(), 'preserve me')

    def test_restore_refuses_existing_volume_before_creating_target(self):
        binary = Path(self.temporary.name) / 'bin'
        binary.mkdir()
        docker = binary / 'docker'
        docker.write_text('#!/bin/sh\nif [ "$1 $2" = "volume ls" ]; then printf "existing-volume\\n"; fi\n')
        docker.chmod(0o700)
        destination = Path(self.temporary.name) / 'new-restore'
        result = subprocess.run(['bash', str(ROOT / 'infrastructure/scripts/restore.sh'),
            str(self.folder), '--target', str(destination), '--project', 'medam-restore-test01'],
            capture_output=True, text=True,
            env={**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('istniejące zasoby', result.stderr)
        self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
