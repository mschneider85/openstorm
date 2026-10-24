#!/bin/sh
# Installs the OpenStorm bridge on Raspberry Pi OS (Lite, 32 bit for the Pi Zero W).
# Used by the image build; also works on an already running Pi: sudo sh install-pi.sh
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)

apt-get update
apt-get install -y --no-install-recommends bluez python3-pip python3-dbus-next
pip3 install --break-system-packages --no-cache-dir bless==0.3.0

install -d /opt/openstorm
install -m 755 "$DIR/openstorm_bridge.py" /opt/openstorm/
install -m 644 "$DIR/openstorm-bridge.service" /etc/systemd/system/
systemctl enable openstorm-bridge.service

# Bluetooth name shown to the EV3 and to other devices.
echo "PRETTY_HOSTNAME=OpenStorm" > /etc/machine-info
echo openstorm > /etc/hostname
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\topenstorm/' /etc/hosts

# Things the bridge does not need; they only slow down booting on a Pi Zero.
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer dphys-swapfile.service; do
  systemctl disable "$unit" 2>/dev/null || true
done

apt-get clean
