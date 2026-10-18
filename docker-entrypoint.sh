#!/bin/sh
set -e

# PaaS runtimes (Railway, Render, ...) bind-mount the persistent volume at
# /app/server/data with root ownership, while the image runs as USER node.
# Chown the data dir before starting so better-sqlite3 can create the DB
# there, then drop back to the unprivileged user.

# Best effort by design: chown fails legitimately under --cap-drop=CHOWN and on
# CIFS/NFS mounts that pin ownership. Startup must not abort over it — the app
# may still be able to write, and if it cannot it says so itself.
ensure_owned() {
  dir="$1"
  [ -n "$dir" ] || return 0

  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "docker-entrypoint: could not create $dir; continuing" >&2
  fi
  [ -d "$dir" ] || return 0

  # Skip the recursive walk when the tree is already node-owned: on a large
  # data dir that is the whole boot cost of this entrypoint.
  if [ "$(stat -c %u "$dir" 2>/dev/null)" = "$NODE_UID" ]; then
    return 0
  fi

  if ! chown -R "$NODE_UID:$NODE_GID" "$dir" 2>/dev/null; then
    echo "docker-entrypoint: could not chown $dir; continuing" >&2
  fi
}

# Litestream persistence: Render's free tier wipes /app/server/data on every
# restart, which would delete the SQLite DB (provider keys, settings). When
# the LITESTREAM_S3_* env vars are set, replicate the DB to S3-compatible
# storage in real time and restore it on boot if the local file is missing.
USE_LITESTREAM=""
if [ -n "$LITESTREAM_S3_BUCKET" ] && [ -n "$LITESTREAM_S3_ENDPOINT" ] && [ -n "$LITESTREAM_ACCESS_KEY_ID" ]; then
  USE_LITESTREAM="1"
fi

if [ "$(id -u)" = "0" ]; then
  NODE_UID="$(id -u node)"
  NODE_GID="$(id -g node)"

  ensure_owned /app/server/data
  # docker/README.md tells single-mount PaaS operators to point these at their
  # one persistent directory, which may sit outside /app/server/data.
  if [ -n "$FREEAPI_DB_PATH" ]; then
    ensure_owned "$(dirname "$FREEAPI_DB_PATH")"
  fi
  if [ -n "$FREEAPI_DB_BACKUP_PATH" ]; then
    ensure_owned "$(dirname "$FREEAPI_DB_BACKUP_PATH")"
  fi

  if [ -n "$USE_LITESTREAM" ]; then
    DB_FILE="${FREEAPI_DB_PATH:-/app/server/data/freeapi.db}"
    if [ ! -f "$DB_FILE" ]; then
      echo "docker-entrypoint: local DB missing, restoring from S3 replica..." >&2
      if litestream restore -if-replica-exists -config /etc/litestream.yml -o "$DB_FILE" 2>&1; then
        echo "docker-entrypoint: DB restored from replica" >&2
      else
        echo "docker-entrypoint: no replica found, starting with a fresh DB" >&2
      fi
      chown "$NODE_UID:$NODE_GID" "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" 2>/dev/null || true
    fi
  fi

  # setpriv ships in util-linux on node:20-bookworm-slim, so it is always
  # present; exec'ing it keeps node as PID 1 so signals reach the server.
  if [ -n "$USE_LITESTREAM" ]; then
    exec setpriv --reuid=node --regid=node --init-groups -- \
      litestream replicate -config /etc/litestream.yml --exec "$*"
  else
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
  fi
fi

if [ -n "$USE_LITESTREAM" ]; then
  exec litestream replicate -config /etc/litestream.yml --exec "$*"
else
  exec "$@"
fi
