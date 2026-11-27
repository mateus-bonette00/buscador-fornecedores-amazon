#!/bin/sh
# Roda tudo localmente. Defina WORKER_HOST (alias SSH) para executar os lotes em um servidor.
set -eu
cd "$(dirname "$0")/.."
if [ ! -f dist/index.html ]; then
  npm run build
fi
exec node server/index.js ${WORKER_HOST:+--worker-host "$WORKER_HOST"} "$@"
