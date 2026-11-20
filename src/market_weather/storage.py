"""Immutable snapshots and crash-safe latest pointer with monotonic ordering."""
import json
import os
import tempfile
from pathlib import Path
from datetime import datetime


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def publish(root, snapshot):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    # Writers are serialized for both the check and replacement. Stale lock is
    # explicit rather than force-cleared: don't race a possibly live process.
    lock = root / '.publish.lock'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.close(fd)
        path = root / 'snapshots' / (snapshot['snapshot_id'] + '.json')
        if path.exists():
            raise ValueError('immutable snapshot already exists')
        atomic_json(path, snapshot)
        latest_path = root / 'latest.json'
        old = json.loads(latest_path.read_text()) if latest_path.exists() else None
        newer = old is None or datetime.fromisoformat(snapshot['started_at']) > datetime.fromisoformat(old['started_at'])
        useful = any(v.get('status') in ('succeeded', 'partial') for v in snapshot['modules'].values())
        if newer and useful:
            atomic_json(latest_path, snapshot)
            return True
        return False
    finally:
        lock.unlink(missing_ok=True)
