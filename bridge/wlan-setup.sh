#!/bin/sh
# At boot: a network the Pi knows (added on the setup page http://openstorm.local/wlan,
# or in the Raspberry Pi Imager), else the Pi opens its own network "OpenStorm".
set -u

rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true

# Networks in range, for the setup page: with its own network open the Pi cannot scan.
mkdir -p /run/openstorm
sleep 3
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list --rescan yes > /run/openstorm/networks.new 2>/dev/null \
  && mv /run/openstorm/networks.new /run/openstorm/networks

known=$(nmcli -t -f NAME,TYPE connection show | grep ':802-11-wireless$' | grep -vc '^OpenStorm-Hotspot:')
if [ "$known" -gt 0 ]; then
  # NetworkManager connects to a known network on its own; give it time.
  for second in $(seq 1 40); do
    if nmcli -t -f DEVICE,STATE device | grep -q '^wlan0:connected$'; then
      echo "Verbunden mit $(nmcli -t -f GENERAL.CONNECTION device show wlan0 | cut -d: -f2-)"
      exit 0
    fi
    sleep 1
  done
  echo "Kein bekanntes WLAN erreichbar, öffne eigenes WLAN"
else
  echo "Noch kein WLAN eingerichtet, öffne eigenes WLAN"
fi

nmcli --wait 30 connection up OpenStorm-Hotspot
