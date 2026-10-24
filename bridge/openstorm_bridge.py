#!/usr/bin/env python3
"""OpenStorm bridge for a Raspberry Pi.

Connects the OpenStorm web app with a LEGO EV3 brick (Bluetooth Classic / RFCOMM).
The app reaches the bridge in two ways:

WLAN: the bridge serves the app itself on http://openstorm.local/ (Safari, no
  app needed). WebSocket /ws: binary messages are bytes for/from the EV3, text
  messages are single JSON commands/events.

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
                                       {"event": "error", "message": str}
"""

import asyncio
import json
import logging
import os
import socket
import subprocess
from typing import Callable, Dict, List, Optional

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
ADAPTER_PATH = "/org/bluez/hci0"

log = logging.getLogger("openstorm")


# --- Pure helpers (unit tested) -----------------------------------------------


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


# --- The bridge ---------------------------------------------------------------


class Bridge:
    """Shares one EV3 connection between all connected apps (BLE and WLAN).

    Everything from the EV3 and every event goes to all apps; each app only
    picks the replies it is waiting for.
    """

    def __init__(self, bluez=None, link: Optional[Ev3Link] = None, led: Optional[StatusLed] = None) -> None:
        self.state = load_state()
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

    async def command(self, line: str) -> None:
        try:
            cmd = json.loads(line)
        except ValueError:
            self._event({"event": "error", "message": "Ungültiger Befehl"})
            return
        name = cmd.get("cmd")
        log.info("Command: %s", name)
        try:
            if name in ("scan", "connect") and self.bluetooth_error:
                raise RuntimeError("Bluetooth der Brücke ist nicht bereit: " + self.bluetooth_error)
            if name == "status":
                self._event(self._status())
            elif name == "scan":
                async with self.busy:
                    devices = await self.bluez.scan()
                self._event({"event": "devices", "devices": devices})
            elif name == "connect":
                await self._connect(cmd.get("address") or self.state.get("address"))
            elif name == "disconnect":
                self.link.close()
                self.led.connected(False)
                self._event({"event": "disconnected", "reason": "Getrennt"})
            else:
                self._event({"event": "error", "message": "Unbekannter Befehl: {}".format(name)})
        except Exception as e:  # report every failure to the app instead of dying
            log.exception("Command %s failed", name)
            self._event({"event": "error", "message": str(e) or e.__class__.__name__})

    async def _connect(self, address: Optional[str]) -> None:
        if not address:
            self._event({"event": "error", "message": "Kein EV3 ausgewählt"})
            return
        async with self.busy:
            if self.link.connected and self.state.get("address") == address:
                self._event({"event": "connected", "address": address, "name": self.state.get("name")})
                return
            self.link.close()
            await self.bluez.ensure_paired(address)
            await self.link.connect(address)
            name = await self.bluez.name_of(address)
            self.state = {"address": address, "name": name}
            save_state(self.state)
        log.info("Connected to EV3 %s (%s)", name, address)
        self.led.connected(True)
        self._event({"event": "connected", "address": address, "name": name})

    def _status(self) -> Dict:
        return {
            "event": "status",
            "connected": self.link.connected,
            "address": self.state.get("address"),
            "name": self.state.get("name"),
            "bluetooth": self.bluetooth_error is None,
            "error": self.bluetooth_error,
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
        self.bridge.event_sinks.append(lambda event: self._notify(CONTROL_UUID, encode_event(event)))
        log.info("Advertising as %s", BLE_NAME)

    def _on_write(self, characteristic, value: bytearray) -> None:
        characteristic.value = value
        uuid = str(characteristic.uuid).lower()
        if uuid == DATA_IN_UUID:
            asyncio.ensure_future(self.bridge.to_ev3(bytes(value)))
        elif uuid == CONTROL_UUID:
            for line in self.control_in.push(bytes(value)):
                asyncio.ensure_future(self.bridge.command(line))

    def _notify(self, uuid: str, data: bytes) -> None:
        characteristic = self.server.get_characteristic(uuid)
        for piece in chunks(data):
            characteristic.value = bytearray(piece)
            self.server.update_value(SERVICE_UUID, uuid)


def make_web_app(bridge: Bridge, www_dir: str = WWW_DIR):
    """WLAN access: serves the app and a WebSocket at /ws."""
    from aiohttp import WSMsgType, web

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
                    asyncio.ensure_future(bridge.command(msg.data))
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

    app = web.Application()
    app.router.add_get("/ws", websocket)
    app.router.add_get("/log", show_log)
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
    asyncio.run(main())
