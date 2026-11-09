"""Settings composition inside InvenTree, not the application backend.

InvenTree API is private. Only the authenticated Fastify service supplies mutation
correlation IDs. django-structlog 11 requires explicit trust of its X-Request-ID.
"""
from InvenTree.settings import *  # noqa: F401,F403
from InvenTree.cache import cache_host, get_cache_config

DJANGO_STRUCTLOG_TRUST_UPSTREAM_REQUEST_ID = True

# Keep the worker broker consistent even when InvenTree bypasses its default
# cache for migrations/read-only checks. The upstream worker alias is otherwise
# absent, and django-q2 gives the upstream default ORM key precedence over Redis.
if not cache_host():
    raise RuntimeError('MEDAM requires the configured worker Redis cache.')
CACHES = {**CACHES, 'worker': get_cache_config(True)}  # noqa: F405
Q_CLUSTER = {key: value for key, value in Q_CLUSTER.items() if key != 'orm'}  # noqa: F405
Q_CLUSTER['django_redis'] = 'worker'
