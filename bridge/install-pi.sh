#!/bin/sh
# Installs the OpenStorm bridge on Raspberry Pi OS (Lite, 32 bit for the Pi Zero W).
# Used by the image build and by every update of a running bridge (see Updater in
# openstorm_bridge.py), so it must be safe to run again; also: sudo sh install-pi.sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

# Downloads only when something is missing, so updates stay quick.
PACKAGES="bluez python3-pip python3-dbus-next python3-aiohttp avahi-daemon rfkill openssh-server dnsmasq-base"
BLESS_VERSION=0.3.0
if ! dpkg -s $PACKAGES >/dev/null 2>&1; then
  echo "Installing packages …"
  apt-get update
  apt-get install -y --no-install-recommends $PACKAGES
  apt-get clean
fi
if [ "$(pip3 show bless 2>/dev/null | sed -n 's/^Version: //p')" != "$BLESS_VERSION" ]; then
  echo "Installing bless $BLESS_VERSION …"
  pip3 install --break-system-packages --no-cache-dir "bless==$BLESS_VERSION"
fi

install -d /opt/openstorm
install -m 755 "$DIR/openstorm_bridge.py" /opt/openstorm/
if [ -f "$DIR/VERSION" ]; then install -m 644 "$DIR/VERSION" /opt/openstorm/; fi
install -m 644 "$DIR/openstorm-bridge.service" /etc/systemd/system/
systemctl enable openstorm-bridge.service

# The web app (built with base "/"), served on http://openstorm.local/
if [ -d "$DIR/www" ]; then
  rm -rf /opt/openstorm/www
  cp -r "$DIR/www" /opt/openstorm/www
fi

# WLAN: a known network, else the Pi opens its own network "OpenStorm" (password:
# openstorm), where every name leads to the setup page (captive portal).
install -d -m 700 /etc/NetworkManager/system-connections
install -m 600 "$DIR/OpenStorm-Hotspot.nmconnection" /etc/NetworkManager/system-connections/
install -d /etc/NetworkManager/dnsmasq-shared.d
install -m 644 "$DIR/openstorm-captive.conf" /etc/NetworkManager/dnsmasq-shared.d/
install -m 755 "$DIR/wlan-setup.sh" /opt/openstorm/
install -m 644 "$DIR/wlan.html" /opt/openstorm/
install -m 644 "$DIR/openstorm-wlan.service" /etc/systemd/system/
systemctl enable openstorm-wlan.service
# Earlier versions read the home network from this file; NetworkManager keeps it now.
rm -f /boot/firmware/openstorm-wlan.txt /boot/openstorm-wlan.txt
# WLAN stays blocked until a country is set; the bridge unblocks it (see service).
for cmdline in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
  if [ -f "$cmdline" ] && ! grep -q ieee80211_regdom "$cmdline"; then
    sed -i '1 s/$/ cfg80211.ieee80211_regdom=DE/' "$cmdline"
  fi
done

# Bluetooth name shown to the EV3 and to other devices.
echo "PRETTY_HOSTNAME=OpenStorm" > /etc/machine-info
echo openstorm > /etc/hostname
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\topenstorm/' /etc/hosts

# The system log in memory only, to spare the SD card.
install -d /etc/systemd/journald.conf.d
install -m 644 "$DIR/openstorm-journald.conf" /etc/systemd/journald.conf.d/openstorm.conf
rm -rf /var/log/journal

# Things the bridge does not need; they only slow down booting on a Pi Zero (rsyslog,
# if installed, would write the log to the SD card again).
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer dphys-swapfile.service rsyslog.service; do
  systemctl disable "$unit" 2>/dev/null || true
done

# On a running Pi (update): pick up changed unit files and network profiles. The
# bridge restarts itself afterwards.
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  systemctl restart systemd-journald 2>/dev/null || true
  nmcli connection reload 2>/dev/null || true
fi
# Lets the next update skip this script if none of the system files changed.
python3 "$DIR/openstorm_bridge.py" --fingerprint "$DIR" > /opt/openstorm/SYSTEM
echo "Installation done: $(cat "$DIR/VERSION" 2>/dev/null || echo dev)"
