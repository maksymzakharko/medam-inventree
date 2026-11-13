#!/usr/bin/env python3
"""Refuse a checkpoint while a supported InvenTree broker contains work.

Run only after every writer, including the worker, stopped with exit code zero.
Redis removes messages on dequeue and has no acknowledgement/lock queue, so its
empty broker alone cannot prove that worker processes completed their tasks.
The caller must establish graceful worker shutdown before invoking this check.

The decision function has no Django dependency so it can be tested in isolation.
"""

from dataclasses import dataclass
import os
import sys
from typing import Any


@dataclass(frozen=True)
class CheckResult:
    broker_class: str
    pending: Any
    locked: Any
    total: Any
    ok: bool
    reason: str


def _count(value):
    """A boolean or missing count must never count as evidence of emptiness."""
    return type(value) is int and value >= 0


def check_broker(broker, *, orm_type, redis_type, orm_total=None):
    """Check exact supported broker types; unknown implementations fail closed.

    ``orm_total`` must include all rows for this cluster key, including NULL lock
    values omitted by the ORM broker's pending/locked counters. For Redis, the
    inherited ``lock_size()`` returns None because this broker does not use locks.
    """
    kind = type(broker)
    name = f'{kind.__module__}.{kind.__qualname__}'
    if kind is not orm_type and kind is not redis_type:
        return CheckResult(name, None, None, None, False, 'unsupported broker')

    pending = broker.queue_size()
    locked = broker.lock_size()
    if kind is orm_type:
        if not all(_count(value) for value in (pending, locked, orm_total)):
            return CheckResult(name, pending, locked, orm_total, False, 'invalid ORM counts')
        empty = pending == 0 and locked == 0 and orm_total == 0
        return CheckResult(name, pending, locked, orm_total, empty,
                           'empty ORM queue' if empty else 'ORM queue contains work')

    if not _count(pending) or not (locked is None or _count(locked)):
        return CheckResult(name, pending, locked, None, False, 'invalid Redis counts')
    empty = pending == 0 and (locked is None or locked == 0)
    return CheckResult(name, pending, locked, None, empty,
                       'empty Redis queue after graceful shutdown' if empty
                       else 'Redis queue contains work')


def configure_read_only_context():
    # InvenTree 1.7 inspects argv while importing InvenTree.ready. Plain Python
    # startup otherwise schedules maintenance jobs, even during a broker check.
    sys.argv = [sys.argv[0], 'check']
    # All libpq connections made by Django must reject accidental DB writes.
    # Append after existing options so a prior setting cannot disable this guard.
    options = os.environ.get('PGOPTIONS', '')
    os.environ['PGOPTIONS'] = f'{options} -c default_transaction_read_only=on'.strip()


def main():
    configure_read_only_context()
    # This path belongs to the pinned official InvenTree container image.
    sys.path.insert(0, '/home/inventree/src/backend/InvenTree')
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'InvenTree.settings')
    try:
        import django
        django.setup()
        from django_q.brokers import get_broker
        from django_q.brokers.orm import ORM
        from django_q.brokers.redis_broker import Redis
        from django_q.conf import Conf
        from django_q.models import OrmQ

        broker = get_broker()
        total = (OrmQ.objects.using(Conf.ORM).filter(key=broker.list_key).count()
                 if type(broker) is ORM else None)
        result = check_broker(broker, orm_type=ORM, redis_type=Redis, orm_total=total)
        print(f'Worker broker: {result.broker_class}; pending={result.pending!r}; '
              f'locked={result.locked!r}; total={result.total!r}; {result.reason}',
              file=sys.stderr)
        return 0 if result.ok else 1
    except Exception as error:
        # Driver errors can include connection details; do not disclose secrets.
        print(f'Worker broker check failed ({type(error).__name__}); checkpoint refused.',
              file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
