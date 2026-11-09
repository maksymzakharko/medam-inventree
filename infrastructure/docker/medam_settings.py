"""Settings composition inside InvenTree, not the application backend.

InvenTree API is private. Only the authenticated Fastify service supplies mutation
correlation IDs. django-structlog 11 requires explicit trust of its X-Request-ID.
"""
from InvenTree.settings import *  # noqa: F401,F403

DJANGO_STRUCTLOG_TRUST_UPSTREAM_REQUEST_ID = True

# InvenTree 1.7.0 leaves the default ORM key present when enabling django_redis.
# django-q2 gives ORM precedence; explicitly select the configured Redis broker.
# Never switch an existing installation's broker with queued work.
if Q_CLUSTER.get('django_redis') != 'worker':  # noqa: F405
    raise RuntimeError('MEDAM requires the configured worker Redis cache.')
Q_CLUSTER = {key: value for key, value in Q_CLUSTER.items() if key != 'orm'}  # noqa: F405
