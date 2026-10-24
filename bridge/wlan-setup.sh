#!/bin/sh
# Reads openstorm-wlan.txt from the SD card's boot partition (editable on any PC)
# and connects to that network. Falls back to the OpenStorm hotspot otherwise.
set -u

for f in /boot/firmware/openstorm-wlan.txt /boot/openstorm-wlan.txt; do
  [ -f "$f" ] && CONFIG=$f && break
done

value() {
  # Notepad may add a BOM and Windows line endings.
  sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$CONFIG" | grep "^$1=" | head -n 1 | cut -d= -f2-
}

rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true

NAME=""
if [ -n "${CONFIG:-}" ]; then
  NAME=$(value WLAN_NAME)
  PASSWORD=$(value WLAN_PASSWORT)
fi

nmcli connection delete OpenStorm-Home >/dev/null 2>&1 || true
if [ -n "$NAME" ]; then
  if [ -n "$PASSWORD" ]; then
    nmcli connection add type wifi con-name OpenStorm-Home ifname wlan0 ssid "$NAME" \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASSWORD" connection.autoconnect-priority 10 >/dev/null
  else
    nmcli connection add type wifi con-name OpenStorm-Home ifname wlan0 ssid "$NAME" \
      connection.autoconnect-priority 10 >/dev/null
  fi
  # The network may need a moment to show up in the scan.
  for attempt in 1 2 3; do
    if nmcli --wait 30 connection up OpenStorm-Home >/dev/null 2>&1; then
      echo "Verbunden mit WLAN $NAME"
      exit 0
    fi
    sleep 5
  done
  echo "WLAN $NAME nicht erreichbar, öffne eigenes WLAN"
fi

nmcli --wait 30 connection up OpenStorm-Hotspot
