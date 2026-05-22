# Secrets directory (gitignored)

This directory is the mount point for `docker-compose.yml`. The runtime
reads its secret material from files here, **never** from baked-in env
vars or the repo.

```
secrets/
  session-key         # required — suiprivkey…, base64 32-byte secret, or the dashboard's .key JSON
  memwal-delegate     # optional — 64-char hex MemWal delegate
```

All files are **gitignored** (see the project root `.gitignore`):
`*.key`, `*.delegate-key`, and the whole `secrets/` directory.

## How to populate

After rotating the session key in the dashboard:

```bash
# Option A — the dashboard's .key JSON works as-is
cp ~/Downloads/synapse-session-XXXXXXXX.key ./secrets/session-key

# Option B — extract the base64 secret
jq -r .secretBase64 ~/Downloads/synapse-session-XXXXXXXX.key > ./secrets/session-key

# Option C — paste a suiprivkey1… string
echo "suiprivkey1qz..." > ./secrets/session-key

# Optional MemWal delegate (hex, no 0x prefix)
echo "064dae..." > ./secrets/memwal-delegate

chmod 600 ./secrets/*
```

Then `docker compose up --build`.

## Rotation

1. Rotate the session key in the dashboard → download the new `.key`.
2. Overwrite `./secrets/session-key`.
3. `docker compose restart runtime` — the next tick uses the new key.

The on-chain `rotate_session_key` call invalidates the old key
immediately; the container restart just picks up the new one for its
own signing. No rebuild required.
