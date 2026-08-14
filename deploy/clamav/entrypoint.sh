#!/bin/sh

set -eu

startup_config="/tmp/ichat-freshclam-startup.conf"

# clamd is intentionally not running during this update. Remove NotifyClamd
# so a successful startup refresh does not emit a misleading socket warning.
sed '/^NotifyClamd[[:space:]]/d' /etc/clamav/freshclam.conf > "$startup_config"

attempt=1
while [ "$attempt" -le 3 ]; do
    if freshclam --foreground --stdout --config-file="$startup_config"; then
        break
    fi
    if [ "$attempt" -eq 3 ]; then
        echo "WARNING: ClamAV startup update failed; readiness will remain fail-closed if signatures are stale" >&2
        break
    fi
    echo "ClamAV startup update failed; retrying ($attempt/3)" >&2
    attempt=$((attempt + 1))
    sleep 5
done

rm -f "$startup_config"
exec /init "$@"
