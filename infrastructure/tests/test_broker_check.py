#!/usr/bin/env python3
"""Exercise broker drain decisions without Django, Redis, or a database.

Run: python3 infrastructure/tests/test_broker_check.py
The Redis cases assume the caller has already proved graceful worker exit zero.
"""
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[1] / 'scripts' / 'inventree-broker-check.py'
SPEC = importlib.util.spec_from_file_location('medam_broker_check', HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeBroker:
    def __init__(self, pending=0, locked=0):
        self.pending = pending
        self.locked = locked

    def queue_size(self):
        return self.pending

    def lock_size(self):
        return self.locked


class FakeORM(FakeBroker):
    pass


class FakeRedis(FakeBroker):
    pass


class CustomRedis(FakeRedis):
    pass


class CustomORM(FakeORM):
    pass


class BrokerDrainSafety(unittest.TestCase):
    def check(self, broker, total=None):
        return MODULE.check_broker(broker, orm_type=FakeORM,
                                   redis_type=FakeRedis, orm_total=total)

    def test_empty_orm_requires_explicit_total(self):
        self.assertTrue(self.check(FakeORM(), total=0).ok)
        self.assertFalse(self.check(FakeORM()).ok)

    def test_orm_total_catches_rows_missing_from_pending_and_locked_counts(self):
        # A nullable ORM lock timestamp can evade both time-based count filters.
        result = self.check(FakeORM(), total=1)
        self.assertFalse(result.ok)
        self.assertEqual(result.pending, 0)
        self.assertEqual(result.locked, 0)
        self.assertEqual(result.total, 1)

    def test_orm_pending_or_locked_tasks_refuse_checkpoint(self):
        for pending, locked in ((1, 0), (0, 1), (2, 3)):
            with self.subTest(pending=pending, locked=locked):
                self.assertFalse(self.check(FakeORM(pending, locked),
                                            total=pending + locked).ok)

    def test_orm_inconsistent_zero_total_does_not_override_outstanding_counts(self):
        self.assertFalse(self.check(FakeORM(1, 0), total=0).ok)
        self.assertFalse(self.check(FakeORM(0, 1), total=0).ok)

    def test_redis_without_acknowledgement_locks_accepts_none(self):
        result = self.check(FakeRedis(0, None))
        self.assertTrue(result.ok)
        self.assertIsNone(result.locked)
        self.assertIsNone(result.total)

    def test_empty_redis_can_report_zero_locks(self):
        self.assertTrue(self.check(FakeRedis()).ok)

    def test_redis_pending_or_locked_tasks_refuse_checkpoint(self):
        for pending, locked in ((1, None), (1, 0), (0, 1)):
            with self.subTest(pending=pending, locked=locked):
                self.assertFalse(self.check(FakeRedis(pending, locked)).ok)

    def test_unknown_broker_refuses_even_when_counts_are_zero(self):
        result = self.check(FakeBroker())
        self.assertFalse(result.ok)
        self.assertTrue(result.reason)

    def test_subclasses_do_not_inherit_trusted_broker_semantics(self):
        for broker in (CustomRedis(0, None), CustomORM()):
            with self.subTest(broker=type(broker).__name__):
                self.assertFalse(self.check(broker, total=0).ok)

    def test_invalid_pending_counts_refuse_for_both_brokers(self):
        for pending in (None, False, True, -1, 0.0, '0'):
            for broker_type in (FakeORM, FakeRedis):
                with self.subTest(pending=repr(pending), broker=broker_type.__name__):
                    self.assertFalse(self.check(broker_type(pending, 0), total=0).ok)

    def test_invalid_locked_counts_refuse_for_both_brokers(self):
        for locked in (False, True, -1, 0.0, '0'):
            for broker_type in (FakeORM, FakeRedis):
                with self.subTest(locked=repr(locked), broker=broker_type.__name__):
                    self.assertFalse(self.check(broker_type(0, locked), total=0).ok)
        self.assertFalse(self.check(FakeORM(0, None), total=0).ok)

    def test_invalid_orm_totals_refuse(self):
        for total in (None, False, True, -1, 0.0, '0'):
            with self.subTest(total=repr(total)):
                self.assertFalse(self.check(FakeORM(), total=total).ok)

    def test_result_preserves_broker_identity_and_has_failure_reason(self):
        result = self.check(FakeORM(1, 0), total=1)
        self.assertIn('FakeORM', result.broker_class)
        self.assertTrue(result.reason)


class ReadOnlyStartupSafety(unittest.TestCase):
    def test_check_context_preserves_executable_and_enables_read_only_connections(self):
        with mock.patch.object(sys, 'argv', ['/medam/inventree-broker-check.py', 'ignored']), \
                mock.patch.dict(os.environ, {}, clear=True):
            MODULE.configure_read_only_context()
            self.assertEqual(sys.argv, ['/medam/inventree-broker-check.py', 'check'])
            self.assertEqual(os.environ['PGOPTIONS'], '-c default_transaction_read_only=on')

    def test_existing_connection_options_are_preserved_before_read_only_guard(self):
        existing = '-c statement_timeout=3000 -c default_transaction_read_only=off'
        with mock.patch.object(sys, 'argv', ['/usr/bin/python3']), \
                mock.patch.dict(os.environ, {'PGOPTIONS': existing}, clear=True):
            MODULE.configure_read_only_context()
            self.assertEqual(os.environ['PGOPTIONS'],
                             existing + ' -c default_transaction_read_only=on')


if __name__ == '__main__':
    unittest.main()
