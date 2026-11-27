#!/bin/sh
# Roda tudo localmente. Defina WORKER_HOST (alias SSH) para executar os lotes em um servidor.
set -eu
cd "$(dirname "$0")/.."
exec python3 -B app.py ${WORKER_HOST:+--worker-host "$WORKER_HOST"} "$@"
