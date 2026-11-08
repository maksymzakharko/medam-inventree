#!/usr/bin/env python3
"""Validate complete MEDAM checkpoints before extracting into a new private directory.

No Docker, SQL, network access, or shell evaluation is performed by this helper.
Checksums establish integrity; obtain checkpoints only from the trusted restic repository.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile

PARTS = {
    'app.dump', 'inventree.dump', 'inventree-data.tar.gz', 'caddy-data.tar.gz',
    'caddy-config.tar.gz', 'config.tar.gz', 'source.tar.gz', 'secrets.tar.gz',
    'image-lock.json', 'operation-state.json',
}


def members(archive):
    seen = set()
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
            raise ValueError('Archive contains an unsafe path, link, or special file')
        normalized = str(path)
        if normalized in seen:
            raise ValueError('Archive contains duplicate paths')
        seen.add(normalized)
        yield member


def validate(folder):
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir() or folder.name.endswith('.partial'):
        raise ValueError('Expected a complete checkpoint directory')
    for name in PARTS | {'manifest.json', 'SHA256SUMS'}:
        file = folder / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size == 0:
            raise ValueError(f'Missing or unsafe checkpoint part: {name}')
    manifest = json.loads((folder / 'manifest.json').read_text())
    if (manifest.get('format') != 2 or set(manifest.get('parts', [])) != PARTS
            or manifest.get('postgresMajor') != 17 or manifest.get('inventreeVersion') != '1.7.0'
            or manifest.get('inventreeApiVersion') != 570):
        raise ValueError('Unsupported checkpoint format or software version')
    sums = {}
    for line in (folder / 'SHA256SUMS').read_text().splitlines():
        checksum, name = line.split('  ', 1)
        if name in sums or name not in PARTS | {'manifest.json'} or len(checksum) != 64:
            raise ValueError('Unsafe or duplicate checksum entry')
        sums[name] = checksum
    if set(sums) != PARTS | {'manifest.json'}:
        raise ValueError('Incomplete checksum list')
    for name, expected in sums.items():
        digest = hashlib.sha256()
        with (folder / name).open('rb') as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError(f'Checksum mismatch: {name}')
    for name in sorted(PARTS):
        if name.endswith('.tar.gz'):
            with tarfile.open(folder / name, 'r:gz') as archive:
                list(members(archive))
    lock = json.loads((folder / 'image-lock.json').read_text())
    for service in ('api', 'edge', 'app-db', 'inventree-db', 'inventree-server', 'inventree-cache'):
        image = lock.get(service, {})
        if not isinstance(image.get('id'), str) or not image['id'].startswith('sha256:'):
            raise ValueError('Missing image identity')
    return manifest


def extract_archive(source, destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tarfile.open(source, 'r:gz') as archive:
        for member in members(archive):
            file = destination / member.name
            if member.isdir():
                file.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.extractfile(member) as incoming, file.open('xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                # Private configuration stays private; preserve only executable bits.
                file.chmod(0o700 if member.mode & 0o111 else 0o600)


def extract(folder, destination):
    folder, destination = Path(folder), Path(destination)
    validate(folder)
    # Atomic refusal of every existing target, including an empty directory or symlink.
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    extract_archive(folder / 'source.tar.gz', destination)
    extract_archive(folder / 'secrets.tar.gz', destination / 'secrets')
    extract_archive(folder / 'config.tar.gz', destination / 'recovery-evidence' / 'original-config')
    for name in ('manifest.json', 'image-lock.json', 'operation-state.json', 'SHA256SUMS'):
        shutil.copyfile(folder / name, destination / 'recovery-evidence' / name)
    # Source archives deliberately exclude .env and secrets. Restore writes a local-only .env.
    if (destination / '.env').exists():
        raise ValueError('Source archive unexpectedly contains .env')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'extract'])
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('target', type=Path, nargs='?')
    args = parser.parse_args()
    if args.command == 'extract':
        if args.target is None:
            parser.error('extract requires a new target directory')
        extract(args.checkpoint, args.target)
    else:
        validate(args.checkpoint)
    print('Checkpoint integrity and archive paths verified.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, KeyError) as error:
        raise SystemExit(f'Checkpoint refused: {error}') from None
