"""Run only inside official InvenTree, after migrations; never a custom Python API.

Bootstraps the integration account using InvenTree's own models and token lifecycle.
No inventory quantities are changed. Token is written to a private mounted file.
"""
import datetime
import os
import sys
from pathlib import Path

import django

sys.path.insert(0, '/home/inventree/src/backend/InvenTree')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'InvenTree.settings')
django.setup()

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import transaction
from common.models import InvenTreeSetting
from users.models import ApiToken, RuleSet

finalize = '--finalize' in sys.argv
output = Path('/medam-secrets/inventree_token')
if not output.parent.is_dir():
    raise SystemExit('Mount the private secret directory at /medam-secrets.')

with transaction.atomic():
    group, _ = Group.objects.get_or_create(name='MEDAM integration managed')
    User = get_user_model()
    user, created = User.objects.get_or_create(username='medam-service')
    if not created and (user.is_superuser or user.is_staff or user.has_usable_password()):
        raise SystemExit('Refusing to replace an existing unmanaged or privileged medam-service account.')
    user.is_staff = False
    user.is_superuser = False
    user.is_active = True
    user.set_unusable_password()
    user.save()
    user.groups.set([group])
    user.user_permissions.clear()
    # Stock writes are required; unrelated sales/build/purchase/admin permissions are absent.
    rules = {
        'stock': dict(can_view=True, can_add=True, can_change=True, can_delete=False),
        'part': dict(can_view=True, can_add=False, can_change=False, can_delete=False),
        'stock_location': dict(can_view=True, can_add=not finalize, can_change=False, can_delete=False),
    }
    # Disable every unrelated role; deleting it alone can leave stale Django grants.
    RuleSet.objects.filter(group=group).exclude(name__in=rules).update(
        can_view=False, can_add=False, can_change=False, can_delete=False)
    for name, flags in rules.items():
        RuleSet.objects.update_or_create(group=group, name=name, defaults=flags)
    from users.tasks import update_group_roles
    update_group_roles(group)
    InvenTreeSetting.set_setting('AUDIT_LOG_ENABLED', True)
    InvenTreeSetting.set_setting('AUDIT_LOG_DELETE_OLD_ENTRIES', False)

    valid = None
    if output.is_symlink():
        raise SystemExit('Refusing a symlink for the service token.')
    if output.is_file():
        valid = ApiToken.get_from_string(output.read_text().strip())
        if valid and valid.user_id != user.pk:
            raise SystemExit('Refusing to reuse a token belonging to another identity.')
    if valid and not valid.active:
        valid = None
    if not valid:
        ApiToken.objects.filter(user=user, name='MEDAM backend', revoked=False).update(
            revoked=True, revocation_reason='Managed bootstrap token replacement')
        token = ApiToken.objects.create(user=user, name='MEDAM backend', expiry=datetime.date.today() + datetime.timedelta(days=365))
        raw = token.token
        # Preserve existing bind-mounted inode; no token appears in stdout or arguments.
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            os.write(descriptor, (raw + '\n').encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
print('Integration account configured; token saved privately; audit enabled; location creation ' + ('disabled.' if finalize else 'enabled for bootstrap only.'))
