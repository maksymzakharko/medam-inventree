"""Settings composition inside InvenTree, not the application backend.

InvenTree API is private. Only the authenticated Fastify service supplies mutation
correlation IDs. django-structlog 11 requires explicit trust of its X-Request-ID.
"""
from InvenTree.settings import *  # noqa: F401,F403

DJANGO_STRUCTLOG_TRUST_UPSTREAM_REQUEST_ID = True
