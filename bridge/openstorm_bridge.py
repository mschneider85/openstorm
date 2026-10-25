#!/usr/bin/env python3
"""OpenStorm bridge for a Raspberry Pi.

Connects the OpenStorm web app with a LEGO EV3 brick (Bluetooth Classic / RFCOMM).
The app reaches the bridge in two ways:

WLAN: the bridge serves the app itself on http://openstorm.local/ (Safari, no
  app needed). WebSocket /ws: binary messages are bytes for/from the EV3, text
  messages are single JSON commands/events. /wlan sets up the Pi's WLAN (see Wlan).

Bluetooth LE (e.g. Bluefy browser), GATT service SERVICE_UUID:
  DATA_IN   write / write without response   bytes app -> EV3
  DATA_OUT  notify                            bytes EV3 -> app
  CONTROL   write + notify                    newline-delimited JSON

The data characteristics carry a plain byte stream. EV3 messages are length
prefixed, so the app reassembles them itself. Everything sent over BLE is split
into CHUNK bytes, which fit into any connection regardless of the negotiated MTU.

Control commands (app -> bridge):    Events (bridge -> app):
  {"cmd": "status"}                    {"event": "status", "connected": bool,
                                         "address": str|null, "name": str|null}
  {"cmd": "scan"}                      {"event": "devices", "devices": [...]}
  {"cmd": "connect", "address"?: str}  {"event": "connected", "address", "name"}
  {"cmd": "disconnect"}                {"event": "disconnected", "reason": str}
  {"cmd": "update_check"}              {"event": "update_info", "current": str,
                                         "latest": str, "available": bool}
  {"cmd": "update"}                    {"event": "updating", "version": str},
                                         then the bridge restarts itself
                                       {"event": "error", "message": str}

Updates come from the GitHub release "pi-update": version.json names the
version and the SHA-256 of openstorm-update.tar.gz, which holds the bridge
directory with the built app. Its install-pi.sh installs everything, including
missing packages and changed services, like when the SD card image was built.
"""

import asyncio
import hashlib
import io
import json
import logging
import os
import py_compile
import shutil
import socket
import subprocess
import sys
import tarfile
from typing import Awaitable, Callable, Dict, List, Optional

SERVICE_UUID = "5e3d0001-8b6f-4c1e-9a3f-0e7d3c2b1a00"
DATA_IN_UUID = "5e3d0002-8b6f-4c1e-9a3f-0e7d3c2b1a00"
DATA_OUT_UUID = "5e3d0003-8b6f-4c1e-9a3f-0e7d3c2b1a00"
CONTROL_UUID = "5e3d0004-8b6f-4c1e-9a3f-0e7d3c2b1a00"

BLE_NAME = "OpenStorm"
CHUNK = 20
EV3_PIN = "1234"
RFCOMM_CHANNEL = 1
SCAN_SECONDS = 10
STATE_FILE = os.environ.get("OPENSTORM_STATE", "/var/lib/openstorm/ev3.json")
WWW_DIR = os.environ.get("OPENSTORM_WWW", "/opt/openstorm/www")
HTTP_PORT = int(os.environ.get("OPENSTORM_HTTP_PORT", "80"))
BLE_ENABLED = os.environ.get("OPENSTORM_BLE", "1") != "0"
BLUETOOTH_RETRY_SECONDS = 5
INSTALL_TIMEOUT_SECONDS = 30 * 60
APP_DIR = os.path.dirname(os.path.abspath(__file__))
UPDATE_URL = os.environ.get(
    "OPENSTORM_UPDATE_URL", "https://github.com/mschneider85/openstorm/releases/download/pi-update/")
ADAPTER_PATH = "/org/bluez/hci0"
WLAN_DEVICE = "wlan0"
HOTSPOT = "OpenStorm-Hotspot"
HOTSPOT_SSID = "OpenStorm"
HOTSPOT_ADDRESS = "10.42.0.1"
# Written by wlan-setup.sh before the Pi opens its own network; it cannot scan then.
NETWORKS_FILE = os.environ.get("OPENSTORM_NETWORKS", "/run/openstorm/networks")
SWITCH_DELAY_SECONDS = 2
FALLBACK_SECONDS = 25

log = logging.getLogger("openstorm")


# --- Pure helpers (unit tested) -----------------------------------------------


def read_version(app_dir: str = APP_DIR) -> str:
    try:
        with open(os.path.join(app_dir, "VERSION")) as f:
            return f.read().strip() or "dev"
    except OSError:
        return "dev"


def unpack_bundle(data: bytes, sha256: str, dest: str) -> None:
    """Checks an update bundle and unpacks it into dest (which is emptied first)."""
    if hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError("Update beschädigt (Prüfsumme falsch), bitte nochmal versuchen")
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        if hasattr(tarfile, "data_filter"):
            tar.extractall(dest, filter="data")
        else:  # Python < 3.12 without the security backport
            tar.extractall(dest)
    for required in ("openstorm_bridge.py", "wlan.html", "install-pi.sh", "VERSION", os.path.join("www", "index.html")):
        if not os.path.isfile(os.path.join(dest, required)):
            raise ValueError("Update unvollständig ({} fehlt)".format(required))
    py_compile.compile(os.path.join(dest, "openstorm_bridge.py"), doraise=True)


# What a quick update replaces; everything else in the bundle belongs to the system setup.
APP_FILES = ("openstorm_bridge.py", "wlan.html", "VERSION", "SYSTEM", "www")


def system_fingerprint(directory: str) -> str:
    """Hash of the system setup files (installer, services, network profiles) in directory."""
    digest = hashlib.sha256()
    for root, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__" and not (root == directory and d in APP_FILES))
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, directory)
            if rel in APP_FILES or name.startswith("test_"):
                continue
            with open(path, "rb") as f:
                digest.update(rel.encode() + b"\0" + f.read() + b"\0")
    return digest.hexdigest()


def replace_app(new: str, app_dir: str) -> None:
    """Quick update: swaps only the bridge script, the WLAN page, VERSION and the web app."""
    www, old_www = os.path.join(app_dir, "www"), os.path.join(app_dir, "www.old")
    shutil.rmtree(old_www, ignore_errors=True)
    if os.path.isdir(www):
        os.rename(www, old_www)
    shutil.copytree(os.path.join(new, "www"), www)
    for name in ("openstorm_bridge.py", "wlan.html", "VERSION"):
        shutil.copy(os.path.join(new, name), os.path.join(app_dir, name + ".new"))
        os.replace(os.path.join(app_dir, name + ".new"), os.path.join(app_dir, name))
    shutil.rmtree(old_www, ignore_errors=True)


async def run_installer(directory: str) -> None:
    """Runs install-pi.sh from an unpacked bundle: packages, services, bridge and app."""
    process = await asyncio.create_subprocess_exec(
        "sh", os.path.join(directory, "install-pi.sh"),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env=dict(os.environ, DEBIAN_FRONTEND="noninteractive"))
    last = ""

    async def read_output() -> None:
        nonlocal last
        async for raw in process.stdout:
            line = raw.decode(errors="replace").rstrip()
            if line:
                last = line
                log.info("install: %s", line)

    try:
        await asyncio.wait_for(asyncio.gather(read_output(), process.wait()), INSTALL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        raise RuntimeError("Installation dauert zu lange, abgebrochen")
    if process.returncode:
        raise RuntimeError("Installation fehlgeschlagen: " + last)


def chunks(data: bytes, size: int = CHUNK) -> List[bytes]:
    """Splits data into pieces of at most `size` bytes."""
    return [data[i:i + size] for i in range(0, len(data), size)]


class LineBuffer:
    """Collects bytes and returns complete newline-terminated lines."""

    def __init__(self) -> None:
        self._buffer = b""

    def push(self, data: bytes) -> List[str]:
        self._buffer += data
        *lines, self._buffer = self._buffer.split(b"\n")
        return [line.decode("utf-8", "replace") for line in lines if line.strip()]


def encode_event(event: Dict) -> bytes:
    return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


def is_ev3_class(device_class: Optional[int]) -> bool:
    """EV3 bricks report the Bluetooth device class "Toy / Robot" (major 0x08, minor 0x01)."""
    if device_class is None:
        return False
    return (device_class >> 8) & 0x1F == 0x08 and (device_class >> 2) & 0x3F == 0x01


def device_path(address: str) -> str:
    return "{}/dev_{}".format(ADAPTER_PATH, address.upper().replace(":", "_"))


def load_state() -> Dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: Dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except OSError as e:
        log.warning("Could not save state: %s", e)


# --- Bluetooth Classic: EV3 connection ----------------------------------------


class Ev3Link:
    """RFCOMM connection to the brick; received bytes go to `on_data`."""

    def __init__(self, on_data: Callable[[bytes], None], on_close: Callable[[str], None]):
        self.on_data = on_data
        self.on_close = on_close
        self.sock: Optional[socket.socket] = None
        self.reader: Optional[asyncio.Task] = None

    @property
    def connected(self) -> bool:
        return self.sock is not None

    async def connect(self, address: str) -> None:
        loop = asyncio.get_event_loop()
        sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
        sock.settimeout(20)
        try:
            await loop.run_in_executor(None, sock.connect, (address, RFCOMM_CHANNEL))
        except OSError:
            sock.close()
            raise
        sock.setblocking(False)
        self.sock = sock
        self.reader = asyncio.ensure_future(self._read_loop(sock))

    async def _read_loop(self, sock: socket.socket) -> None:
        loop = asyncio.get_event_loop()
        reason = "EV3 ausgeschaltet oder außer Reichweite"
        try:
            while True:
                data = await loop.sock_recv(sock, 1024)
                if not data:
                    break
                self.on_data(data)
        except asyncio.CancelledError:
            return
        except OSError as e:
            reason = "Bluetooth-Fehler: {}".format(e.strerror or e)
        if self.sock is sock:
            self._close_socket()
            self.on_close(reason)

    async def send(self, data: bytes) -> None:
        if self.sock is None:
            return
        await asyncio.get_event_loop().sock_sendall(self.sock, data)

    def close(self) -> None:
        if self.reader:
            self.reader.cancel()
            self.reader = None
        self._close_socket()

    def _close_socket(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


# --- BlueZ via D-Bus: pairing agent and discovery -----------------------------


def make_agent():
    from dbus_next.service import ServiceInterface, method

    class PinAgent(ServiceInterface):
        """Answers pairing requests: the EV3 asks for PIN 1234 by default."""

        def __init__(self):
            super().__init__("org.bluez.Agent1")

        @method()
        def Release(self):  # noqa: N802
            pass

        @method()
        def RequestPinCode(self, device: "o") -> "s":  # noqa: F821, N802
            log.info("PIN requested by %s", device)
            return EV3_PIN

        @method()
        def DisplayPinCode(self, device: "o", pincode: "s"):  # noqa: F821, N802
            pass

        @method()
        def RequestPasskey(self, device: "o") -> "u":  # noqa: F821, N802
            return int(EV3_PIN)

        @method()
        def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):  # noqa: F821, N802
            pass

        @method()
        def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: F821, N802
            log.info("Confirming pairing with %s (%06d)", device, passkey)

        @method()
        def RequestAuthorization(self, device: "o"):  # noqa: F821, N802
            pass

        @method()
        def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: F821, N802
            pass

        @method()
        def Cancel(self):  # noqa: N802
            pass

    return PinAgent()


class Bluez:
    AGENT_PATH = "/org/openstorm/agent"

    async def start(self) -> None:
        from dbus_next.aio import MessageBus
        from dbus_next.constants import BusType

        self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        try:
            self.bus.export(self.AGENT_PATH, make_agent())
            manager = await self._interface("/org/bluez", "org.bluez.AgentManager1")
            await manager.call_register_agent(self.AGENT_PATH, "KeyboardDisplay")
            await manager.call_request_default_agent(self.AGENT_PATH)
            adapter = await self._interface(ADAPTER_PATH, "org.bluez.Adapter1")
            await adapter.set_powered(True)
        except Exception:
            self.bus.disconnect()  # also drops the agent, so a retry starts clean
            raise

    async def _interface(self, path: str, name: str):
        introspection = await self.bus.introspect("org.bluez", path)
        return self.bus.get_proxy_object("org.bluez", path, introspection).get_interface(name)

    async def devices(self) -> List[Dict]:
        """All known Classic devices (paired or seen in the last scan), EV3 first."""
        manager = await self._interface("/", "org.freedesktop.DBus.ObjectManager")
        objects = await manager.call_get_managed_objects()
        result = []
        for path, interfaces in objects.items():
            dev = interfaces.get("org.bluez.Device1")
            if not dev or not path.startswith(ADAPTER_PATH + "/"):
                continue
            value = lambda key, default=None: dev[key].value if key in dev else default  # noqa: E731
            device_class = value("Class")
            if device_class is None and not value("Paired", False):
                continue  # BLE-only devices have no class; they can't be an EV3
            result.append({
                "address": value("Address"),
                "name": value("Name") or value("Address"),
                "paired": bool(value("Paired", False)),
                "ev3": is_ev3_class(device_class),
            })
        result.sort(key=lambda d: (not d["ev3"], not d["paired"], d["name"]))
        return result

    async def scan(self, seconds: int = SCAN_SECONDS) -> List[Dict]:
        from dbus_next import Variant

        adapter = await self._interface(ADAPTER_PATH, "org.bluez.Adapter1")
        await adapter.call_set_discovery_filter({"Transport": Variant("s", "bredr")})
        await adapter.call_start_discovery()
        try:
            await asyncio.sleep(seconds)
        finally:
            try:
                await adapter.call_stop_discovery()
            except Exception:  # discovery may already have ended
                pass
        return await self.devices()

    async def ensure_paired(self, address: str) -> None:
        device = await self._interface(device_path(address), "org.bluez.Device1")
        if not await device.get_paired():
            log.info("Pairing with %s - confirm on the EV3", address)
            await device.call_pair()
        await device.set_trusted(True)

    async def name_of(self, address: str) -> str:
        try:
            device = await self._interface(device_path(address), "org.bluez.Device1")
            return await device.get_name()
        except Exception:
            return address


# --- Status light --------------------------------------------------------------


class StatusLed:
    """The Pi's green activity LED: steady = EV3 connected, slow blink = waiting."""

    def __init__(self, base: str = "/sys/class/leds") -> None:
        self.path = next(
            (os.path.join(base, name) for name in ("ACT", "led0") if os.path.isdir(os.path.join(base, name))),
            None,
        )

    def _write(self, name: str, value: str) -> None:
        if not self.path:
            return
        try:
            with open(os.path.join(self.path, name), "w") as f:
                f.write(value)
        except OSError as e:
            log.debug("LED %s: %s", name, e)

    def connected(self, on: bool) -> None:
        if on:
            self._write("trigger", "none")
            self._write("brightness", "1")
        else:
            self._write("trigger", "timer")
            self._write("delay_on", "200")
            self._write("delay_off", "1800")


class Updater:
    """Fetches new versions of the bridge and the app from GitHub."""

    def __init__(self, url: str = UPDATE_URL, app_dir: str = APP_DIR,
                 installer: Callable[[str], Awaitable[None]] = run_installer) -> None:
        self.url = url
        self.app_dir = app_dir
        self.installer = installer

    @property
    def current(self) -> str:
        return read_version(self.app_dir)

    async def _get(self, name: str) -> bytes:
        import aiohttp

        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
                async with session.get(self.url + name) as response:
                    response.raise_for_status()
                    return await response.read()
        except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as e:
            log.warning("Update server not reachable: %s", e)
            raise RuntimeError("Kein Internet: Für Updates muss der Pi im Heim-WLAN sein") from e
        except aiohttp.ClientResponseError as e:
            raise RuntimeError("Update-Server antwortet nicht ({})".format(e.status)) from e

    def _installed_system(self) -> Optional[str]:
        """Fingerprint written by install-pi.sh after its last successful run."""
        try:
            with open(os.path.join(self.app_dir, "SYSTEM")) as f:
                return f.read().strip()
        except OSError:
            return None

    async def latest(self) -> Dict:
        return json.loads(await self._get("version.json"))

    async def install(self) -> str:
        info = await self.latest()
        data = await self._get("openstorm-update.tar.gz")
        new = os.path.join(self.app_dir, ".update")
        try:
            unpack_bundle(data, info["sha256"], new)
            if self._installed_system() == system_fingerprint(new):
                log.info("Quick update to %s (system setup unchanged)", info["version"])
                replace_app(new, self.app_dir)
            else:
                log.info("Installing version %s", info["version"])
                await self.installer(new)
        finally:
            shutil.rmtree(new, ignore_errors=True)
        log.info("Installed version %s", info["version"])
        return info["version"]


def restart() -> None:
    """Runs the (updated) bridge anew."""
    if os.environ.get("INVOCATION_ID"):  # started by systemd; the unit file may have changed, too
        subprocess.Popen(["systemctl", "--no-block", "restart", "openstorm-bridge.service"])
    else:
        script = os.path.join(APP_DIR, "openstorm_bridge.py")
        os.execv(sys.executable, [sys.executable, script])


# --- WLAN: the Pi's own network for the setup, or the networks the user added -------


def split_terse(line: str) -> List[str]:
    """Splits a line of `nmcli -t` output; colons and backslashes in values are escaped."""
    fields, current, escaped = [], "", False
    for ch in line:
        if escaped:
            current += ch
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ":":
            fields.append(current)
            current = ""
        else:
            current += ch
    fields.append(current)
    return fields


def terse_values(text: str) -> Dict[str, str]:
    """`nmcli -t -f a,b ... show` output ("a:value" per line) as a dict."""
    values = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        values[key] = ":".join(split_terse(rest))
    return values


def parse_networks(text: str) -> List[Dict]:
    """`nmcli -t -f SSID,SIGNAL,SECURITY device wifi list`: each network once, strongest first."""
    best: Dict[str, Dict] = {}
    for line in text.splitlines():
        fields = split_terse(line)
        if len(fields) < 3 or not fields[0]:
            continue
        ssid, signal = fields[0], int(fields[1]) if fields[1].isdigit() else 0
        if ssid == HOTSPOT_SSID:
            continue
        if ssid not in best or signal > best[ssid]["signal"]:
            best[ssid] = {"ssid": ssid, "signal": signal, "secure": fields[2] not in ("", "--")}
    return sorted(best.values(), key=lambda n: -n["signal"])


def check_wlan(ssid: str, password: str) -> None:
    if not ssid or len(ssid.encode()) > 32:
        raise RuntimeError("Bitte den Namen des WLANs angeben.")
    if password and not 8 <= len(password) <= 63:
        raise RuntimeError("Ein WLAN-Passwort hat 8 bis 63 Zeichen.")


async def nmcli(*args: str, timeout: float = 30) -> str:
    process = await asyncio.create_subprocess_exec(
        "nmcli", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except asyncio.TimeoutError:
        process.kill()
        raise RuntimeError("NetworkManager antwortet nicht")
    if process.returncode:
        raise RuntimeError(err.decode(errors="replace").strip() or "nmcli fehlgeschlagen")
    return out.decode(errors="replace")


class Wlan:
    """The Pi's WLAN through NetworkManager.

    Without a known network the Pi opens its own ("OpenStorm", see wlan-setup.sh);
    the setup page (wlan.html) then adds the home network. Switching networks takes
    the current one away, so answers go out first and the switch follows.
    """

    def __init__(self, run: Callable[..., Awaitable[str]] = nmcli, networks_file: str = NETWORKS_FILE) -> None:
        self.run = run
        self.networks_file = networks_file
        self.joining: Optional[str] = None
        self.error: Optional[str] = None

    async def _active(self) -> str:
        try:
            out = await self.run("-t", "-f", "GENERAL.CONNECTION", "device", "show", WLAN_DEVICE)
        except RuntimeError:
            return ""
        name = terse_values(out).get("GENERAL.CONNECTION", "")
        return "" if name == "--" else name

    async def _profile(self, name: str) -> Dict[str, str]:
        out = await self.run("-t", "-f", "802-11-wireless.ssid,802-11-wireless.mode", "connection", "show", name)
        values = terse_values(out)
        return {"ssid": values.get("802-11-wireless.ssid", ""), "mode": values.get("802-11-wireless.mode", "")}

    async def status(self) -> Dict:
        active = await self._active()
        if active == HOTSPOT:
            mode, ssid = "hotspot", HOTSPOT_SSID
        elif active:
            mode, ssid = "client", (await self._profile(active))["ssid"] or active
        else:
            mode, ssid = "off", None
        return {"mode": mode, "ssid": ssid, "joining": self.joining, "error": self.error}

    async def saved(self) -> List[Dict]:
        """Networks the Pi knows (also ones from the Raspberry Pi Imager), without its own."""
        out = await self.run("-t", "-f", "NAME,TYPE", "connection", "show")
        active = await self._active()
        result = []
        for line in out.splitlines():
            fields = split_terse(line)
            if len(fields) < 2 or fields[1] != "802-11-wireless" or fields[0] == HOTSPOT:
                continue
            profile = await self._profile(fields[0])
            if profile["mode"] == "ap":
                continue
            result.append({"name": fields[0], "ssid": profile["ssid"] or fields[0], "active": fields[0] == active})
        return result

    async def networks(self) -> List[Dict]:
        """Networks in range; while the Pi has its own network, the list from before it opened."""
        try:
            found = parse_networks(await self.run(
                "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto", timeout=20))
        except RuntimeError:
            found = []
        if found:
            return found
        try:
            with open(self.networks_file) as f:
                return parse_networks(f.read())
        except OSError:
            return []

    async def join(self, ssid: str, password: str) -> bool:
        """Stores a network and switches to it. Returns False if it was only stored,
        because the Pi is online and the network is not in range (e.g. the school's)."""
        check_wlan(ssid, password)
        if self.joining:
            raise RuntimeError("Der Pi verbindet sich gerade mit „{}“.".format(self.joining))
        mode = (await self.status())["mode"]
        if mode == "client" and ssid not in [n["ssid"] for n in await self.networks()]:
            await self._store(ssid, password)
            return False
        self.joining, self.error = ssid, None
        asyncio.ensure_future(self._switch(ssid, password))
        return True

    async def _store(self, ssid: str, password: str) -> str:
        """Adds a profile for the network and returns its name. Inactive profiles of the
        same network go (e.g. with an old password); an active one only after switching."""
        for profile in await self.saved():
            if profile["ssid"] == ssid and not profile["active"]:
                await self.run("connection", "delete", profile["name"])
        taken = [p["name"] for p in await self.saved()]
        name = ssid if ssid not in taken else ssid + " (neu)"
        args = ["connection", "add", "type", "wifi", "con-name", name, "ifname", WLAN_DEVICE, "ssid", ssid,
                "connection.autoconnect-priority", "10"]
        if password:
            args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
        await self.run(*args)
        return name

    async def _switch(self, ssid: str, password: str) -> None:
        await asyncio.sleep(SWITCH_DELAY_SECONDS)  # let the answer reach the app first
        name = None
        try:
            name = await self._store(ssid, password)
            await self.run("--wait", "45", "connection", "up", name, timeout=60)
            for profile in await self.saved():
                if profile["ssid"] == ssid and profile["name"] != name:
                    await self.run("connection", "delete", profile["name"])
            log.info("WLAN: connected to %s", ssid)
        except RuntimeError as e:
            log.warning("WLAN: connecting to %s failed: %s", ssid, e)
            self.error = "Verbinden mit „{}“ hat nicht geklappt. Stimmt das Passwort?".format(ssid)
            if name:
                try:
                    await self.run("connection", "delete", name)
                except RuntimeError:
                    pass
            await self.fallback()
        finally:
            self.joining = None

    async def forget(self, name: str) -> None:
        if name == HOTSPOT:
            raise RuntimeError("Das eigene WLAN des Pi bleibt immer.")
        was_active = name == await self._active()
        await self.run("connection", "delete", name)
        if was_active:
            await self.fallback()

    async def fallback(self) -> None:
        """Like at boot: a known network if one is in range, else the Pi's own network."""
        for _ in range(FALLBACK_SECONDS):
            if (await self.status())["mode"] == "client":
                return
            await asyncio.sleep(1)
        # Its own network open, the Pi cannot scan; keep the list for the setup page.
        try:
            text = await self.run("-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list",
                                  "--rescan", "yes", timeout=20)
            os.makedirs(os.path.dirname(self.networks_file), exist_ok=True)
            with open(self.networks_file, "w") as f:
                f.write(text)
        except (RuntimeError, OSError) as e:
            log.warning("WLAN: scan before opening the own network failed: %s", e)
        try:
            await self.run("--wait", "30", "connection", "up", HOTSPOT, timeout=45)
        except RuntimeError as e:
            log.warning("WLAN: own network failed: %s", e)


# --- The bridge ---------------------------------------------------------------


class Bridge:
    """Shares one EV3 connection between all connected apps (BLE and WLAN).

    Everything from the EV3 and every event goes to all apps; each app only
    picks the replies it is waiting for.
    """

    def __init__(self, bluez=None, link: Optional[Ev3Link] = None, led: Optional[StatusLed] = None,
                 updater: Optional[Updater] = None, restart: Callable[[], None] = restart) -> None:
        self.state = load_state()
        self.updater = updater or Updater()
        self.restart = restart
        self.led = led or StatusLed()
        self.bluez = bluez or Bluez()
        self.link = link or Ev3Link(self._from_ev3, self._ev3_closed)
        self.busy = asyncio.Lock()
        self.data_sinks: List[Callable[[bytes], None]] = []
        self.event_sinks: List[Callable[[Dict], None]] = []
        self.bluetooth_ready = asyncio.Event()
        self.bluetooth_error: Optional[str] = "Bluetooth startet …"

    async def start(self) -> None:
        """Brings up Bluetooth, retrying until it works (the app is served meanwhile)."""
        self.led.connected(False)
        while True:
            try:
                await self.bluez.start()
                break
            except Exception as e:
                self.bluetooth_error = str(e) or e.__class__.__name__
                log.warning("Bluetooth not ready, retrying: %s", self.bluetooth_error)
                await asyncio.sleep(BLUETOOTH_RETRY_SECONDS)
        self.bluetooth_error = None
        self.bluetooth_ready.set()
        log.info("Bluetooth ready")

    # app -> bridge

    async def to_ev3(self, data: bytes) -> None:
        try:
            await self.link.send(data)
        except OSError as e:
            log.warning("Send to EV3 failed: %s", e)

    async def command(self, line: str, reply: Callable[[Dict], None]) -> None:
        """Runs one command. Answers and errors go to the asking app only (`reply`),
        so several apps (or two requests of one app) don't get each other's answers."""
        try:
            cmd = json.loads(line)
        except ValueError:
            reply({"event": "error", "message": "Ungültiger Befehl"})
            return
        name = cmd.get("cmd")
        log.info("Command: %s", name)
        try:
            if name in ("scan", "connect") and self.bluetooth_error:
                raise RuntimeError("Bluetooth der Brücke ist nicht bereit: " + self.bluetooth_error)
            if name == "status":
                reply(self._status())
            elif name == "scan":
                async with self.busy:
                    devices = await self.bluez.scan()
                reply({"event": "devices", "devices": devices})
            elif name == "connect":
                await self._connect(cmd.get("address") or self.state.get("address"), reply)
            elif name == "disconnect":
                self.link.close()
                self.led.connected(False)
                self._event({"event": "disconnected", "reason": "Getrennt"})
            elif name == "update_check":
                current, latest = self.updater.current, (await self.updater.latest())["version"]
                reply({"event": "update_info", "current": current, "latest": latest,
                             "available": latest != current})
            elif name == "update":
                async with self.busy:
                    version = await self.updater.install()
                self._event({"event": "updating", "version": version})
                self.link.close()
                # Give the event a moment to reach the apps, then run the new version.
                asyncio.get_event_loop().call_later(1, self.restart)
            else:
                reply({"event": "error", "message": "Unbekannter Befehl: {}".format(name)})
        except RuntimeError as e:  # expected failures with a message for the app
            log.warning("Command %s failed: %s", name, e)
            reply({"event": "error", "message": str(e)})
        except Exception as e:  # report every failure to the app instead of dying
            log.exception("Command %s failed", name)
            reply({"event": "error", "message": str(e) or e.__class__.__name__})

    async def _connect(self, address: Optional[str], reply: Callable[[Dict], None]) -> None:
        if not address:
            reply({"event": "error", "message": "Kein EV3 ausgewählt"})
            return
        async with self.busy:
            if self.link.connected and self.state.get("address") == address:
                reply({"event": "connected", "address": address, "name": self.state.get("name")})
                return
            self.link.close()
            await self.bluez.ensure_paired(address)
            await self.link.connect(address)
            name = await self.bluez.name_of(address)
            self.state = {"address": address, "name": name}
            save_state(self.state)
        log.info("Connected to EV3 %s (%s)", name, address)
        self.led.connected(True)
        reply({"event": "connected", "address": address, "name": name})

    def _status(self) -> Dict:
        return {
            "event": "status",
            "connected": self.link.connected,
            "address": self.state.get("address"),
            "name": self.state.get("name"),
            "bluetooth": self.bluetooth_error is None,
            "error": self.bluetooth_error,
            "version": self.updater.current,
        }

    # bridge -> apps

    def _event(self, event: Dict) -> None:
        for sink in list(self.event_sinks):
            sink(event)

    def _from_ev3(self, data: bytes) -> None:
        for sink in list(self.data_sinks):
            sink(data)

    def _ev3_closed(self, reason: str) -> None:
        log.info("EV3 connection closed: %s", reason)
        self.led.connected(False)
        self._event({"event": "disconnected", "reason": reason})


class BleFrontend:
    """Bluetooth LE access for browsers with Web Bluetooth (Bluefy, Chrome)."""

    def __init__(self, bridge: Bridge) -> None:
        self.bridge = bridge
        self.control_in = LineBuffer()

    async def start(self) -> None:
        from bless import BlessServer, GATTAttributePermissions as Perm, GATTCharacteristicProperties as Prop

        self.server = BlessServer(name=BLE_NAME, loop=asyncio.get_event_loop())
        self.server.read_request_func = lambda characteristic: characteristic.value or bytearray()
        self.server.write_request_func = self._on_write
        await self.server.add_new_service(SERVICE_UUID)
        await self.server.add_new_characteristic(
            SERVICE_UUID, DATA_IN_UUID, Prop.write | Prop.write_without_response, None, Perm.writeable)
        await self.server.add_new_characteristic(
            SERVICE_UUID, DATA_OUT_UUID, Prop.read | Prop.notify, bytearray(), Perm.readable)
        await self.server.add_new_characteristic(
            SERVICE_UUID, CONTROL_UUID, Prop.read | Prop.write | Prop.write_without_response | Prop.notify,
            bytearray(), Perm.readable | Perm.writeable)
        await self.server.start()
        self.bridge.data_sinks.append(lambda data: self._notify(DATA_OUT_UUID, data))
        self.bridge.event_sinks.append(self._reply)
        log.info("Advertising as %s", BLE_NAME)

    def _on_write(self, characteristic, value: bytearray) -> None:
        characteristic.value = value
        uuid = str(characteristic.uuid).lower()
        if uuid == DATA_IN_UUID:
            asyncio.ensure_future(self.bridge.to_ev3(bytes(value)))
        elif uuid == CONTROL_UUID:
            for line in self.control_in.push(bytes(value)):
                asyncio.ensure_future(self.bridge.command(line, self._reply))

    def _reply(self, event: Dict) -> None:
        self._notify(CONTROL_UUID, encode_event(event))

    def _notify(self, uuid: str, data: bytes) -> None:
        characteristic = self.server.get_characteristic(uuid)
        for piece in chunks(data):
            characteristic.value = bytearray(piece)
            self.server.update_value(SERVICE_UUID, uuid)


APPLE_SUCCESS = "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>"


def is_own_host(host: Optional[str]) -> bool:
    """Names the Pi answers to; in its own network every other name leads to it as well."""
    if not host or host in ("openstorm", "localhost") or host.endswith(".local"):
        return True
    return all(part.isdigit() for part in host.split("."))  # an address typed in


def make_web_app(bridge: Bridge, www_dir: str = WWW_DIR, wlan: Optional[Wlan] = None, page_dir: str = APP_DIR):
    """WLAN access: serves the app, a WebSocket at /ws and the WLAN setup at /wlan.

    In the Pi's own network every name resolves to the Pi (dnsmasq, see install-pi.sh).
    The iPad's check for internet then gets the setup page, which iOS opens by
    itself, until the user chooses to go on without a home network.
    """
    from aiohttp import WSMsgType, web

    wlan = wlan or Wlan()
    without_home_wlan = set()  # addresses of devices that chose to stay in the Pi's network

    @web.middleware
    async def captive(request, handler):
        if is_own_host(request.url.host):
            return await handler(request)
        if request.remote in without_home_wlan:
            if request.path == "/generate_204":
                return web.Response(status=204)
            return web.Response(text=APPLE_SUCCESS, content_type="text/html")
        raise web.HTTPFound("http://{}/wlan".format(HOTSPOT_ADDRESS))

    async def json_body(request) -> Dict:
        # Only JSON: a foreign web page cannot send that to the Pi without asking first (CORS).
        if request.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType()
        try:
            return await request.json()
        except ValueError:
            raise web.HTTPBadRequest()

    def wlan_api(action):
        async def handle(request):
            try:
                return web.json_response(await action(request))
            except RuntimeError as e:
                return web.json_response({"error": str(e)}, status=400)
        return handle

    async def wlan_status(request):
        return dict(await wlan.status(), saved=await wlan.saved())

    async def wlan_networks(request):
        return {"networks": await wlan.networks()}

    async def wlan_join(request):
        body = await json_body(request)
        switching = await wlan.join(str(body.get("ssid", "")).strip(), str(body.get("password", "")))
        return {"switching": switching}

    async def wlan_forget(request):
        await wlan.forget(str((await json_body(request)).get("name", "")))
        return {}

    async def wlan_stay(request):
        await json_body(request)
        without_home_wlan.add(request.remote)
        return {}

    async def wlan_page(request):
        response = web.FileResponse(os.path.join(page_dir, "wlan.html"))
        response.headers["Cache-Control"] = "no-cache"
        return response

    async def websocket(request):
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        log.info("App connected via WLAN (%s)", request.remote)
        loop = asyncio.get_event_loop()

        def send_data(data: bytes) -> None:
            if not ws.closed:
                loop.create_task(ws.send_bytes(data))

        def send_event(event: Dict) -> None:
            if not ws.closed:
                loop.create_task(ws.send_str(json.dumps(event, ensure_ascii=False)))

        bridge.data_sinks.append(send_data)
        bridge.event_sinks.append(send_event)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    await bridge.to_ev3(msg.data)
                elif msg.type == WSMsgType.TEXT:
                    asyncio.ensure_future(bridge.command(msg.data, send_event))
        finally:
            bridge.data_sinks.remove(send_data)
            bridge.event_sinks.remove(send_event)
            log.info("App disconnected (%s)", request.remote)
        return ws

    async def index(request):
        response = web.FileResponse(os.path.join(www_dir, "index.html"))
        response.headers["Cache-Control"] = "no-cache"
        return response

    async def show_log(request):
        """Recent log of the bridge, WLAN setup and Bluetooth, for troubleshooting."""
        units = ["openstorm-bridge", "openstorm-wlan", "bluetooth", "hciuart", "NetworkManager"]
        command = ["journalctl", "-b", "--no-pager", "-n", "400"] + [a for u in units for a in ("-u", u)]
        try:
            text = subprocess.run(command, capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError) as e:
            text = "journalctl failed: {}".format(e)
        return web.Response(text=text)

    app = web.Application(middlewares=[captive])
    app.router.add_get("/ws", websocket)
    app.router.add_get("/log", show_log)
    app.router.add_get("/wlan", wlan_page)
    app.router.add_get("/api/wlan", wlan_api(wlan_status))
    app.router.add_get("/api/wlan/networks", wlan_api(wlan_networks))
    app.router.add_post("/api/wlan/join", wlan_api(wlan_join))
    app.router.add_post("/api/wlan/forget", wlan_api(wlan_forget))
    app.router.add_post("/api/wlan/stay", wlan_api(wlan_stay))
    app.router.add_get("/", index)
    if os.path.isdir(www_dir):
        app.router.add_static("/", www_dir)
    return app


async def main() -> None:
    from aiohttp import web

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    bridge = Bridge()
    # Serve the app first, so it shows what is wrong if Bluetooth does not come up.
    runner = web.AppRunner(make_web_app(bridge))
    await runner.setup()
    await web.TCPSite(runner, port=HTTP_PORT).start()
    log.info("App available on port %d", HTTP_PORT)

    await bridge.start()
    if BLE_ENABLED:
        try:
            await BleFrontend(bridge).start()
        except Exception:  # WLAN keeps working without BLE
            log.exception("Bluetooth LE could not be started")

    await asyncio.Event().wait()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--fingerprint"]:  # used by install-pi.sh
        print(system_fingerprint(sys.argv[2]))
    else:
        asyncio.run(main())
