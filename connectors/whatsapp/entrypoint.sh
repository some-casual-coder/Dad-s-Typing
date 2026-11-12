#!/bin/sh
# Hosted disks (e.g. Render) mount DATA_DIR owned by root: claim it, then drop
# to the unprivileged user. A container already started as that user runs as is.
set -e
if [ "$(id -u)" = "0" ]; then
  dir="${DATA_DIR:-/data}"
  mkdir -p "$dir" && chown 10001:10001 "$dir" && chmod 700 "$dir"
  exec setpriv --reuid=10001 --regid=10001 --clear-groups /usr/local/bin/connector "$@"
fi
exec /usr/local/bin/connector "$@"
