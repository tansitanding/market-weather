"""Recompute a captured run offline from the same previous published state."""
import json
import tempfile
from pathlib import Path
from datetime import datetime
from market_weather.pipeline import collect
from market_weather.storage import atomic_json
root = Path('.local/data')
original = json.loads((root/'latest.json').read_text())
prior = [json.loads(p.read_text()) for p in (root/'snapshots').glob('*.json')]
prior = [s for s in prior if s['started_at'] < original['started_at']]
with tempfile.TemporaryDirectory(prefix='replay-', dir='.local') as replay_root:
    if prior:
        atomic_json(Path(replay_root)/'latest.json', max(prior,key=lambda s:s['started_at']))
    replay, _ = collect(replay_root, now=datetime.fromisoformat(original['started_at']),
                        replay=root/'runs'/original['snapshot_id']/'raw')
    for key in ('industry','cn_market','global','news'):
        assert original['modules'][key]['data'] == replay['modules'][key]['data'], key + ': replay mismatch'
    assert original['rule_version'] == replay['rule_version']
print('Offline replay matches: industry / cn_market / global / news')
