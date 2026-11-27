import { execFileSync } from 'node:child_process';
import { Pending } from './suppliers.js';

const SERVER = /\b([A-Z]{2})(?:-[A-Z0-9]+)*#\d+\b/;

export const vpnDeps = {
  execFileSync,
};

export class ProtonManual {
  requireUs() {
    let stdout;
    try {
      stdout = vpnDeps.execFileSync(
        'nmcli',
        ['--escape', 'no', '--terse', '--fields', 'TYPE,STATE,NAME', 'connection', 'show', '--active'],
        {
          encoding: 'utf-8',
          env: { ...process.env, LC_ALL: 'C' },
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      throw new Pending('Não foi possível verificar a conexão Proton VPN no servidor.');
    }

    const countries = new Set();
    for (const line of String(stdout).split(/\r?\n/)) {
      const profile = /^(?:vpn|wireguard):activated:ProtonVPN (.+)$/.exec(line);
      if (!profile) continue;
      const match = new RegExp(`^${SERVER.source}$`).exec(profile[1]);
      if (match) countries.add(match[1]);
    }

    if (countries.size === 1 && countries.has('US')) return;
    if (countries.size > 0) {
      throw new Pending('Conecte o Proton VPN a um servidor dos Estados Unidos antes da consulta à SMC.');
    }
    throw new Pending('Conecte o Proton VPN manualmente no servidor antes da consulta à SMC.');
  }
}

export function protonConnection() {
  const connection = new ProtonManual();
  connection.requireUs();
  return connection;
}
