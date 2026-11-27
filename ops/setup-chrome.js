#!/usr/bin/env node
/**
 * Register the extension's Native Messaging host in this machine's Chrome profile.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_NAME = 'com.buscador_fornecedores.suppliers';

function main() {
  const extensionDir = path.join(ROOT, 'chrome-extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf-8'));
  const publicKey = Buffer.from(manifest.key, 'base64');
  const hash = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  const extensionId = hash.replace(/[0-9a-f]/g, (ch) => 'abcdefghijklmnop'[Number.parseInt(ch, 16)]);

  const hostPath = path.join(ROOT, 'server', 'chrome-native.js');
  fs.chmodSync(hostPath, 0o700);

  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const targetDir = path.join(xdg, 'google-chrome', 'NativeMessagingHosts');
  fs.mkdirSync(targetDir, { recursive: true });

  const registration = {
    name: HOST_NAME,
    description: 'Supplier page reader',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  const staged = path.join(targetDir, `.${HOST_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(staged, JSON.stringify(registration, null, 2));
  fs.renameSync(staged, path.join(targetDir, `${HOST_NAME}.json`));

  process.stdout.write(`Pasta da extensão: ${extensionDir}\n`);
  process.stdout.write(`ID da extensão: ${extensionId}\n`);
}

main();
