#!/usr/bin/env bash
# Stand up a throwaway PostgreSQL for verifying the v2 migration.
#
# This box has no Docker and no local Postgres, and the GMW dev database is
# remote (credentials redacted in .env.example). The v2 state machine is
# concurrency- and constraint-heavy, so it gets verified against a REAL
# database — not asserted on paper.
#
# Usage:
#   scripts/dev-pg.sh start     # initdb + start on :5433
#   scripts/dev-pg.sh stop
#   scripts/dev-pg.sh status
#   scripts/dev-pg.sh destroy   # stop + wipe the data directory
#
# Then:  PGPASSWORD=postgres psql -h 127.0.0.1 -p 5433 -U postgres -d gmw_mod

set -euo pipefail

PGBIN=/usr/lib/postgresql/18/bin
PGDATA=/var/lib/pg-gmw
PGPORT=5433
DB=gmw_mod
export PGPASSWORD=postgres

if [[ ! -x "$PGBIN/initdb" ]]; then
  echo "PostgreSQL server not installed. Run:"
  echo "  sudo -n apt-get install -y postgresql postgresql-client"
  exit 1
fi

case "${1:-status}" in
  start)
    if [[ ! -d "$PGDATA" ]]; then
      # NOTE: the data dir must live somewhere the `postgres` OS user can
      # traverse. A path under the agent scratch dir fails with EACCES.
      sudo -n mkdir -p "$PGDATA"
      sudo -n chown postgres:postgres "$PGDATA"
      sudo -n chmod 700 "$PGDATA"
      sudo -n -u postgres "$PGBIN/initdb" -D "$PGDATA" -U postgres \
        --auth-local=trust --auth-host=trust >/dev/null
      echo "initialised $PGDATA"
    fi
    sudo -n -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" \
      -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" \
      -l "$PGDATA/log.txt" start
    sleep 2
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres \
      -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
      || psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "CREATE DATABASE $DB"
    echo "ready: postgres://postgres@127.0.0.1:$PGPORT/$DB"
    ;;

  stop)
    sudo -n -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop
    ;;

  status)
    sudo -n -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" status || true
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -c "select version();" || true
    ;;

  destroy)
    sudo -n -u postgres "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop || true
    sudo -n rm -rf "$PGDATA"
    echo "removed $PGDATA"
    ;;

  *)
    echo "usage: $0 {start|stop|status|destroy}" >&2
    exit 2
    ;;
esac
