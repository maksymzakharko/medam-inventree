#!/usr/bin/env python3
"""Exercise real backup orchestration with isolated fake Compose/Docker processes.

Run: python3 infrastructure/tests/test_backup.py
No daemon, repository, credentials or network are used. pg_dump/pg_restore are
stubbed: these checks establish orchestration properties, not PostgreSQL validity.
"""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[2]
RUNNING = ['app-db', 'inventree-db', 'inventree-cache', 'inventree-server',
           'inventree-worker', 'edge', 'api', 'admin-proxy']
WRITERS = ['edge', 'admin-proxy', 'api', 'inventree-server', 'inventree-worker']
GATE = {'gate': {'id': 'inventory', 'operation_id': '00000000-0000-4000-8000-000000000001'},
        'unresolved': [{'id': '00000000-0000-4000-8000-000000000001',
                        'kind': 'consumption', 'state': 'UNCERTAIN'}]}

MOCK = r'''#!/usr/bin/env python3
import io, json, os, pathlib, sys, tarfile
arguments=sys.argv[1:]
name=pathlib.Path(sys.argv[0]).name
with open(os.environ['MEDAM_TEST_EVENTS'],'a') as events:
    events.write(json.dumps({'command':name,'args':arguments})+'\n')
scenario=os.environ.get('MEDAM_TEST_SCENARIO','success')
services=json.loads(os.environ['MEDAM_TEST_RUNNING'])
image='sha256:'+'a'*64
if name=='medam-compose.sh':
    command=arguments[0]
    if command=='ps':
        if '--services' in arguments: print('\n'.join(services))
        else: print('container-'+arguments[-1])
    elif command=='stop':
        if scenario=='stop-command-failed' and arguments[-1]=='api': sys.exit(17)
    elif command=='up':
        required=['-d','--no-deps','--no-recreate','--no-build','--wait','--wait-timeout','240']
        if arguments[1:8] != required: sys.exit(30)
        if scenario=='resume-failed': sys.exit(31)
    elif command=='run':
        if arguments[-2:] != ['python','/medam/check-broker-drained.py']: sys.exit(29)
        if scenario in ('pending-jobs','locked-jobs'): sys.exit(18)
    elif command=='exec':
        service, tool=arguments[2:4]
        if tool=='pg_dump':
            if scenario=='dump-failed' and service=='inventree-db': sys.exit(19)
            sys.stdout.buffer.write(b'PGDMP fixture for '+service.encode()+b'\n')
        elif tool=='pg_restore':
            if not sys.stdin.buffer.read().startswith(b'PGDMP fixture for '): sys.exit(20)
        elif tool=='psql': print(os.environ['MEDAM_TEST_GATE'])
        else: sys.exit(21)
    elif command=='images': print(image)
    else: sys.exit(22)
elif name=='docker':
    if arguments[0]=='ps':
        if scenario=='one-off-writer': print('one-off-writer')
    elif arguments[:2]==['image','inspect']:
        print(json.dumps({'Id':image,'RepoDigests':['fixture@'+image],
                          'Architecture':'amd64','Os':'linux'}))
    elif arguments[0]=='inspect':
        if arguments[2]=='{{.State.ExitCode}}':
            print(137 if scenario=='nonzero-writer-exit' and arguments[-1]=='container-api' else 0)
        elif arguments[2]=='{{.Image}}': print(image)
        else: sys.exit(23)
    elif arguments[0]=='run':
        if '--network' not in arguments or arguments[arguments.index('--network')+1]!='none': sys.exit(24)
        if not any(value.endswith(':ro') for value in arguments): sys.exit(25)
        with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as archive:
            data=b'isolated volume fixture\n';entry=tarfile.TarInfo('fixture.txt');entry.size=len(data)
            archive.addfile(entry,io.BytesIO(data))
    else: sys.exit(26)
elif name=='alert.sh': pass
elif name=='restic': sys.exit(27)  # Unexpected in these scenarios: no remote operations allowed.
else: sys.exit(28)
'''


class BackupSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='medam-backup-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.scripts = self.root / 'infrastructure' / 'scripts'
        self.scripts.mkdir(parents=True)
        self.mock_commands = self.root / 'mock-commands'
        self.mock_commands.mkdir()
        for name in ('backup.sh', 'checkpoint.py'):
            shutil.copy2(PROJECT / 'infrastructure' / 'scripts' / name, self.scripts / name)
        for path in (self.scripts / 'medam-compose.sh', self.scripts / 'alert.sh',
                     self.mock_commands / 'docker', self.mock_commands / 'restic'):
            path.write_text(MOCK)
            path.chmod(0o700)
        (self.root / '.env').write_text('COMPOSE_PROJECT_NAME=fixture\nBACKUP_ROOT=./backups\nSECRETS_DIR=./secrets\n')
        secrets = self.root / 'secrets'
        secrets.mkdir(mode=0o700)
        (secrets / 'fixture').write_text('test-only-secret\n')
        for directory in ('apps', 'packages', 'docs'):
            (self.root / directory).mkdir()
            (self.root / directory / 'fixture.txt').write_text('test-only-source\n')
        for name in ('compose.yaml', 'compose.production.yaml', 'compose.restore.yaml',
                     'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                     '.npmrc', 'tsconfig.base.json', '.dockerignore'):
            (self.root / name).write_text('fixture\n')
        self.events_file = self.root / 'events.jsonl'
        self.environment = dict(os.environ,
            PATH=str(self.mock_commands) + os.pathsep + os.environ['PATH'],
            MEDAM_TEST_EVENTS=str(self.events_file), MEDAM_TEST_RUNNING=json.dumps(RUNNING),
            MEDAM_TEST_GATE=json.dumps(GATE))
        for name in ('BACKUP_ROOT', 'RESTIC_ENV_FILE', 'RESTIC_REPOSITORY',
                     'RESTIC_PASSWORD_FILE', 'ALERT_WEBHOOK_FILE'):
            self.environment.pop(name, None)

    def run_backup(self, scenario='success', mode='--local-only'):
        environment = dict(self.environment, MEDAM_TEST_SCENARIO=scenario)
        result = subprocess.run(['bash', str(self.scripts / 'backup.sh'), mode],
            env=environment, capture_output=True, text=True, timeout=20)
        self.events = [json.loads(line) for line in self.events_file.read_text().splitlines()]
        return result

    def compose_calls(self, command):
        return [event['args'] for event in self.events
                if event['command'] == 'medam-compose.sh' and event['args'][0] == command]

    def assert_not_offsite(self):
        self.assertFalse((self.root / 'backups' / 'last-complete-offsite-checkpoint').exists())
        self.assertFalse(any(event['command'] == 'restic' for event in self.events))

    def assert_resumed(self):
        self.assertEqual(self.compose_calls('up'), [['up', '-d', '--no-deps', '--no-recreate',
            '--no-build', '--wait', '--wait-timeout', '240', *[s for s in RUNNING if s in WRITERS]]])
        self.assertFalse((self.root / 'backups' / '.maintenance').exists())

    def test_complete_local_checkpoint_preserves_gate_and_resumes_writers(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[-1] for call in self.compose_calls('stop')], WRITERS)
        self.assert_resumed()
        self.assert_not_offsite()
        complete = [p for p in (self.root / 'backups').iterdir()
                    if p.is_dir() and not p.name.endswith('.partial')]
        self.assertEqual(len(complete), 1)
        folder = complete[0]
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['format'], 2)
        self.assertEqual(json.loads((folder / 'operation-state.json').read_text()), GATE)
        self.assertIn('Checkpoint integrity and archive paths verified.', result.stdout)
        frozen = datetime.datetime.fromisoformat(manifest['frozenAtUtc'].replace('Z', '+00:00'))
        self.assertLess(abs((datetime.datetime.now(datetime.timezone.utc) - frozen).total_seconds()), 30)
        sql_calls = [call for call in self.compose_calls('exec') if 'psql' in call]
        self.assertEqual(len(sql_calls), 1)
        self.assertTrue(sql_calls[0][-1].startswith('SELECT '))
        first_dump = next(i for i, event in enumerate(self.events) if 'pg_dump' in event['args'])
        last_stop = max(i for i, event in enumerate(self.events)
                        if event['command'] == 'medam-compose.sh' and event['args'][0] == 'stop')
        self.assertLess(last_stop, first_dump)
        volume_copies = [event for event in self.events
                         if event['command'] == 'docker' and event['args'][0] == 'run']
        self.assertEqual(len(volume_copies), 3)

    def test_failed_dump_resumes_prior_services_without_offsite_success(self):
        result = self.run_backup('dump-failed', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assert_resumed()
        self.assert_not_offsite()
        backups = self.root / 'backups'
        self.assertTrue(any(path.name.endswith('.partial') for path in backups.iterdir()))
        self.assertFalse(any(path.is_dir() and not path.name.endswith('.partial') for path in backups.iterdir()))

    def test_failure_preserves_previous_offsite_checkpoint_evidence(self):
        backup_root = self.root / 'backups'
        backup_root.mkdir()
        marker = backup_root / 'last-complete-offsite-checkpoint'
        previous = '2026-11-07T12:00:00Z\n'
        marker.write_text(previous)
        result = self.run_backup('dump-failed', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assert_resumed()
        self.assertEqual(marker.read_text(), previous)
        self.assertFalse(any(event['command'] == 'restic' for event in self.events))

    def test_stop_command_failure_resumes_prior_services_without_dump(self):
        result = self.run_backup('stop-command-failed', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assert_resumed()
        self.assert_not_offsite()
        self.assertFalse(any('pg_dump' in event['args'] for event in self.events))

    def test_nonzero_writer_exit_refuses_checkpoint_and_resumes(self):
        result = self.run_backup('nonzero-writer-exit', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exit 137', result.stderr)
        self.assert_resumed()
        self.assert_not_offsite()
        self.assertFalse(any('pg_dump' in event['args'] for event in self.events))

    def test_oneoff_writer_refuses_before_stopping_services(self):
        result = self.run_backup('one-off-writer', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.compose_calls('stop'), [])
        self.assertEqual(self.compose_calls('up'), [])
        self.assert_not_offsite()
        self.assertFalse((self.root / 'backups' / '.maintenance').exists())

    def test_failed_resume_alerts_and_does_not_claim_offsite_success(self):
        result = self.run_backup('resume-failed', '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ALARM:', result.stderr)
        self.assert_not_offsite()
        self.assertTrue(any(event['command'] == 'alert.sh' for event in self.events))
        self.assertFalse((self.root / 'backups' / '.maintenance').exists())

    def assert_queue_refused(self, scenario):
        result = self.run_backup(scenario, '--offsite')
        self.assertNotEqual(result.returncode, 0)
        self.assert_resumed()
        self.assert_not_offsite()
        self.assertFalse(any('pg_dump' in event['args'] for event in self.events))

    def test_pending_jobs_refuse_checkpoint_and_resume(self):
        self.assert_queue_refused('pending-jobs')

    def test_locked_jobs_refuse_checkpoint_and_resume(self):
        self.assert_queue_refused('locked-jobs')


if __name__ == '__main__':
    unittest.main(verbosity=2)
