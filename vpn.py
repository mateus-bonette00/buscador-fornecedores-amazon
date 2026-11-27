"""Confirm that a US Proton VPN connection is active before querying SMC."""

import os
import re
import subprocess
from contextlib import contextmanager

from suppliers import Pending

SERVER = re.compile(r'\b([A-Z]{2})(?:-[A-Z0-9]+)*#\d+\b')


class ProtonManual:
    def require_us(self):
        try:
            result = subprocess.run(
                ['nmcli', '--escape', 'no', '--terse', '--fields', 'TYPE,STATE,NAME',
                 'connection', 'show', '--active'], check=True, capture_output=True,
                encoding='utf-8', errors='replace', env={**os.environ, 'LC_ALL': 'C'}, timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            raise Pending('Não foi possível verificar a conexão Proton VPN no servidor.') from None

        countries = set()
        for line in result.stdout.splitlines():
            profile = re.fullmatch(r'(?:vpn|wireguard):activated:ProtonVPN (.+)', line)
            if not profile:
                continue
            match = SERVER.fullmatch(profile[1])
            if match:
                countries.add(match[1])

        if countries == {'US'}:
            return
        if countries:
            raise Pending('Conecte o Proton VPN a um servidor dos Estados Unidos antes da consulta à SMC.')
        raise Pending('Conecte o Proton VPN manualmente no servidor antes da consulta à SMC.')


@contextmanager
def proton_connection():
    """The user connects and disconnects the VPN; this only verifies it."""
    connection = ProtonManual()
    connection.require_us()
    yield connection
