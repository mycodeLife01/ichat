#!/bin/sh

set -eu

maximum_age="${CLAMAV_SIGNATURE_MAX_AGE_SECONDS:-172800}"
case "$maximum_age" in
    ''|*[!0-9]*)
        echo "ERROR: CLAMAV_SIGNATURE_MAX_AGE_SECONDS must be a positive integer" >&2
        exit 1
        ;;
esac
if [ "$maximum_age" -le 0 ]; then
    echo "ERROR: CLAMAV_SIGNATURE_MAX_AGE_SECONDS must be a positive integer" >&2
    exit 1
fi

# Query clamd over its wire protocol so this checks the database loaded in
# memory, not merely the newer files that freshclam may have written to disk.
loaded="$(printf 'zVERSION\0' | nc -w 5 127.0.0.1 3310 | tr -d '\000\r\n')"
on_disk="$(freshclam --version 2>/dev/null)"
loaded_version="$(printf '%s\n' "$loaded" | awk -F/ 'NF >= 3 { print $2; exit }')"
disk_version="$(printf '%s\n' "$on_disk" | awk -F/ 'NF >= 3 { print $2; exit }')"
signature_date="$(printf '%s\n' "$loaded" | cut -d/ -f3-)"

if [ -z "$loaded_version" ] || [ -z "$disk_version" ] || [ -z "$signature_date" ]; then
    echo "ERROR: Unable to read the ClamAV signature version" >&2
    exit 1
fi
if [ "$loaded_version" != "$disk_version" ]; then
    echo "ERROR: clamd has not loaded the current on-disk signature database" >&2
    exit 1
fi

if signature_epoch="$(date -u -d "$signature_date UTC" +%s 2>/dev/null)"; then
    :
elif signature_epoch="$(
    date -u -D '%a %b %d %H:%M:%S %Y' -d "$signature_date" +%s 2>/dev/null
)"; then
    # BusyBox date requires an explicit strptime format for clamd's timestamp.
    :
else
    echo "ERROR: Unable to parse the ClamAV signature timestamp" >&2
    exit 1
fi
now_epoch="$(date -u +%s)"
signature_age=$((now_epoch - signature_epoch))
if [ "$signature_age" -lt 0 ] || [ "$signature_age" -gt "$maximum_age" ]; then
    echo "ERROR: ClamAV signatures are outside the configured freshness window" >&2
    exit 1
fi

clamdscan --ping=1 --wait /etc/hosts >/dev/null 2>&1
