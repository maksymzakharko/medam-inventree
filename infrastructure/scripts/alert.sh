#!/usr/bin/env bash
# Optional runtime delivery to an endpoint explicitly configured by the operator.
set -euo pipefail
message=${1:-'MEDAM: wymagane sprawdzenie usługi.'}
printf '%s\n' "$message" >&2
[[ -n ${ALERT_WEBHOOK_FILE:-} ]] || exit 0
[[ -f $ALERT_WEBHOOK_FILE && ! -L $ALERT_WEBHOOK_FILE ]] || exit 1
python3 - "$ALERT_WEBHOOK_FILE" <<'PY'
import os,stat,sys
s=os.lstat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid not in (0,os.getuid()):
    raise SystemExit('Webhook URL must be an operator-owned private regular file.')
PY
url=$(cat "$ALERT_WEBHOOK_FILE")
[[ $url == https://* && $url != *[[:space:]]* && $url != *'"'* && $url != *'\\'* ]] || exit 1
payload=$(python3 - "$message" <<'PY'
import json,sys
print(json.dumps({'message':sys.argv[1]}))
PY
)
# Keep the private webhook URL out of the curl process arguments and logs.
printf 'url = "%s"\n' "$url" | curl --config - --silent --show-error --fail --max-time 10 \
  --header 'Content-Type: application/json' --data "$payload" --output /dev/null
