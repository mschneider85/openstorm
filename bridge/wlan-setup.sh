#!/bin/sh
# At boot: a network the Pi knows (added on the setup page http://openstorm.local/wlan,
# or in the Raspberry Pi Imager), else the Pi opens its own network "OpenStorm".
# Writes what happened to openstorm-wlan.log on the boot partition, readable on any
# PC, since a Pi without network cannot be asked otherwise.
set -u

LOG=/dev/null
for boot in /boot/firmware /boot; do
  [ -f "$boot/config.txt" ] && LOG=$boot/openstorm-wlan.log && break
done
: > "$LOG"
say() {
  echo "$*"
  echo "$(date '+%H:%M:%S') $*" >> "$LOG"
}
run() {
  out=$("$@" 2>&1)
  status=$?
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/    /' >> "$LOG"
  return $status
}
connected() {
  nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q '^wlan0:connected$'
}

say "OpenStorm WLAN start ($(cat /opt/openstorm/VERSION 2>/dev/null || echo dev))"
rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true

# wlan0 shows up a moment after NetworkManager.
for second in $(seq 1 30); do
  nmcli -t -f DEVICE device 2>/dev/null | grep -qx wlan0 && break
  sleep 1
done

# Networks in range, for the setup page: with its own network open the Pi cannot scan.
mkdir -p /run/openstorm
sleep 3
nmcli -t -f SSID,SIGNAL,SECURITY device wifi list --rescan yes > /run/openstorm/networks.new 2>/dev/null \
  && mv /run/openstorm/networks.new /run/openstorm/networks
say "WLANs in range: $(cut -d: -f1 /run/openstorm/networks 2>/dev/null | grep . | sort -u | tr '\n' ' ')"

known=$(nmcli -t -f NAME,TYPE connection show | grep ':802-11-wireless$' | grep -vc '^OpenStorm-Hotspot:')
if [ "$known" -gt 0 ]; then
  say "Known WLANs: $known, waiting for a connection"
  # NetworkManager connects to a known network on its own; give it time.
  for second in $(seq 1 40); do
    if connected; then
      say "Connected to $(nmcli -t -f GENERAL.CONNECTION device show wlan0 | cut -d: -f2-)"
      exit 0
    fi
    sleep 1
  done
  say "No known WLAN in range, opening the own WLAN"
else
  say "No WLAN set up yet, opening the own WLAN"
fi

for attempt in 1 2 3 4 5; do
  if run nmcli --wait 30 connection up OpenStorm-Hotspot; then
    say "Own WLAN \"OpenStorm\" open (http://10.42.0.1)"
    # Who tried to join in the next minutes, for when a device cannot get in.
    systemd-run --no-block --unit=openstorm-wlan-log /bin/sh -c "sleep 240; {
      echo; echo \"\$(date '+%H:%M:%S') Join attempts on the own WLAN:\"
      journalctl -b -u NetworkManager -u wpa_supplicant --no-pager -n 80 | sed 's/^/    /'
      journalctl -b -k --no-pager | grep -i brcm | tail -n 20 | sed 's/^/    /'
    } >> '$LOG'" >/dev/null 2>&1 || true
    exit 0
  fi
  say "Attempt $attempt failed"
  sleep 10
done

say "Could not open the own WLAN. State:"
run nmcli general
run nmcli device
run nmcli -f NAME,TYPE,AUTOCONNECT connection show
run rfkill list
run ls -l /usr/sbin/dnsmasq
run journalctl -b -u NetworkManager --no-pager -n 60
exit 1
