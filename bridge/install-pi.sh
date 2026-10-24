#!/bin/sh
# Installs the OpenStorm bridge on Raspberry Pi OS (Lite, 32 bit for the Pi Zero W).
# Used by the image build; also works on an already running Pi: sudo sh install-pi.sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

apt-get update
apt-get install -y --no-install-recommends bluez python3-pip python3-dbus-next python3-aiohttp avahi-daemon rfkill openssh-server
pip3 install --break-system-packages --no-cache-dir bless==0.3.0

install -d /opt/openstorm
install -m 755 "$DIR/openstorm_bridge.py" /opt/openstorm/
install -m 644 "$DIR/openstorm-bridge.service" /etc/systemd/system/
systemctl enable openstorm-bridge.service

# The web app (built with base "/"), served on http://openstorm.local/
if [ -d "$DIR/www" ]; then
  rm -rf /opt/openstorm/www
  cp -r "$DIR/www" /opt/openstorm/www
fi

# WLAN: the network from openstorm-wlan.txt on the boot partition (editable on any
# PC), else the Pi opens its own network "OpenStorm" (password: openstorm).
install -d -m 700 /etc/NetworkManager/system-connections
install -m 600 "$DIR/OpenStorm-Hotspot.nmconnection" /etc/NetworkManager/system-connections/
install -m 755 "$DIR/wlan-setup.sh" /opt/openstorm/
install -m 644 "$DIR/openstorm-wlan.service" /etc/systemd/system/
systemctl enable openstorm-wlan.service
for boot in /boot/firmware /boot; do
  if [ -f "$boot/config.txt" ]; then
    [ -f "$boot/openstorm-wlan.txt" ] || install -m 644 "$DIR/openstorm-wlan.txt" "$boot/"
    break
  fi
done
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

# Things the bridge does not need; they only slow down booting on a Pi Zero.
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer dphys-swapfile.service; do
  systemctl disable "$unit" 2>/dev/null || true
done

apt-get clean
