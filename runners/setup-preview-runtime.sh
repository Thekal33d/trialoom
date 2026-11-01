#!/usr/bin/env bash
# Add a dedicated socket-capable runtime; preserve the original runsc entry.
set -euo pipefail
test "$(id -u)" = 0
test "$(hostname)" = trialoom-runner
test ! -e /mnt/mac
test -z "${SSH_AUTH_SOCK:-}"
test -z "$(docker ps -q)"
python3 - <<'PY'
import json,pathlib
config=pathlib.Path('/etc/docker/daemon.json')
data=json.loads(config.read_text())
base=data['runtimes']['runsc']
args=base.get('runtimeArgs',[])
assert not any(a.startswith(('--host-uds','--network','--allow-flag-override')) for a in args)
expected={**base,'runtimeArgs':args+['--host-uds=open','--network=none']}
existing=data['runtimes'].get('runsc-preview')
assert existing is None or existing==expected, 'Refusing to overwrite a different runtime'
data['runtimes']['runsc-preview']=expected
config.write_text(json.dumps(data,indent=2)+'\n')
PY
systemctl restart docker
docker info --format '{{json (index .Runtimes "runsc-preview")}}'
