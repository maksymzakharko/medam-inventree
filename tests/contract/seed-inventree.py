"""CI-only fixture inside InvenTree. Never part of the Node application backend."""
import json
import os
import sys
import uuid
from pathlib import Path

if os.environ.get('CI') != 'true' or os.environ.get('MEDAM_CONTRACT_TEST') != 'ci-only-ephemeral':
    raise SystemExit('Refusing fixture creation outside an explicitly selected disposable CI stack.')
sys.path.insert(0, '/home/inventree/src/backend/InvenTree')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'InvenTree.settings')
import django
django.setup()
from django.db import transaction
from part.models import Part
from stock.models import StockLocation

with transaction.atomic():
    marker = str(uuid.uuid4())
    part = Part.objects.create(name='MEDAM CI ' + marker, units='amp.', active=True)
    source = StockLocation.objects.create(name='CI source ' + marker, structural=False, external=False)
    destination = StockLocation.objects.create(name='CI destination ' + marker, structural=False, external=False)
    result = {'partId': part.pk, 'sourceId': source.pk, 'destinationId': destination.pk}
output = Path('/medam-secrets/contract-fixture.json')
output.write_text(json.dumps(result) + '\n')
# Only public fixture identifiers, no credential values; the containing directory stays private.
output.chmod(0o644)
print('Disposable contract fixture created; identifiers written without credentials.')
