"""Register the extension's native messaging host in this machine's Chrome profile."""

import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOST_NAME = 'com.buscador_fornecedores.suppliers'


def main():
    extension = ROOT / 'chrome-extension'
    manifest = json.loads((extension / 'manifest.json').read_text())
    public_key = base64.b64decode(manifest['key'], validate=True)
    extension_id = hashlib.sha256(public_key).hexdigest()[:32].translate(
        str.maketrans('0123456789abcdef', 'abcdefghijklmnop')
    )
    host = ROOT / 'chrome_native.py'
    host.chmod(0o700)
    directory = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    directory = directory / 'google-chrome' / 'NativeMessagingHosts'
    directory.mkdir(parents=True, exist_ok=True)
    registration = {
        'name': HOST_NAME,
        'description': 'Supplier page reader',
        'path': str(host),
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{extension_id}/'],
    }
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as file:
        json.dump(registration, file)
        staged = Path(file.name)
    staged.replace(directory / f'{HOST_NAME}.json')
    print(f'Pasta da extensão: {extension}')
    print(f'ID da extensão: {extension_id}')


if __name__ == '__main__':
    main()
