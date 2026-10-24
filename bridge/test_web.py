"""Tests the WLAN side of the bridge with a fake EV3 and fake BlueZ (needs aiohttp)."""
import asyncio
import json
import os
import tempfile
import unittest

try:
    import aiohttp
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    aiohttp = None

import openstorm_bridge as ob


class FakeBluez:
    async def start(self):
        pass

    async def scan(self):
        return [{"address": "00:16:53:01:02:03", "name": "Robo", "paired": False, "ev3": True}]

    async def ensure_paired(self, address):
        self.paired = address

    async def name_of(self, address):
        return "Robo"


class FlakyBluez(FakeBluez):
    """Bluetooth that only comes up on the second try (e.g. still blocked at boot)."""

    def __init__(self):
        self.attempts = 0

    async def start(self):
        self.attempts += 1
        if self.attempts == 1:
            raise RuntimeError("Blocked through rfkill")


class FakeUpdater:
    current = "v1"

    async def latest(self):
        return {"version": "v2", "sha256": "x"}

    async def install(self):
        self.installed = True
        return "v2"


class FakeLink:
    """Echoes every byte back, like an EV3 that answers instantly."""

    def __init__(self):
        self.connected = False
        self.on_data = None

    async def connect(self, address):
        self.connected = True

    async def send(self, data):
        asyncio.get_event_loop().call_soon(self.on_data, b"reply:" + data)

    def close(self):
        self.connected = False


class FakeLed:
    def __init__(self):
        self.states = []

    def connected(self, on):
        self.states.append(on)


@unittest.skipIf(aiohttp is None, "aiohttp not installed")
class WebTest(unittest.TestCase):
    def test_websocket_flow(self):
        asyncio.run(self._flow())

    async def _flow(self):
        tmp = tempfile.mkdtemp()
        ob.STATE_FILE = os.path.join(tmp, "state.json")
        with open(os.path.join(tmp, "index.html"), "w") as f:
            f.write("<title>OpenStorm</title>")
        link, led = FakeLink(), FakeLed()
        restarts = []
        bridge = ob.Bridge(bluez=FakeBluez(), link=link, led=led, updater=FakeUpdater(),
                           restart=lambda: restarts.append(True))
        link.on_data = bridge._from_ev3
        await bridge.start()
        client = TestClient(TestServer(ob.make_web_app(bridge, tmp)))
        await client.start_server()
        try:
            page = await client.get("/")
            self.assertIn("OpenStorm", await page.text())

            ws = await client.ws_connect("/ws")

            async def ask(cmd):
                await ws.send_str(json.dumps(cmd))
                return json.loads((await ws.receive(timeout=2)).data)

            self.assertEqual((await ask({"cmd": "status"}))["connected"], False)
            self.assertEqual((await ask({"cmd": "scan"}))["devices"][0]["name"], "Robo")
            connected = await ask({"cmd": "connect", "address": "00:16:53:01:02:03"})
            self.assertEqual(connected, {"event": "connected", "address": "00:16:53:01:02:03", "name": "Robo"})
            self.assertEqual(led.states, [False, True])

            await ws.send_bytes(b"\x01\x02")
            self.assertEqual((await ws.receive(timeout=2)).data, b"reply:\x01\x02")

            # The last brick is remembered for the next start.
            with open(ob.STATE_FILE) as f:
                self.assertEqual(json.load(f)["address"], "00:16:53:01:02:03")

            bridge._ev3_closed("aus")
            self.assertEqual(json.loads((await ws.receive(timeout=2)).data)["event"], "disconnected")
            self.assertEqual(led.states[-1], False)

            info = await ask({"cmd": "update_check"})
            self.assertEqual(info, {"event": "update_info", "current": "v1", "latest": "v2", "available": True})
            self.assertEqual(await ask({"cmd": "update"}), {"event": "updating", "version": "v2"})
            await asyncio.sleep(1.2)
            self.assertEqual(restarts, [True])
            await ws.close()
        finally:
            await client.close()

    def test_app_is_served_while_bluetooth_is_down(self):
        asyncio.run(self._bluetooth_down())

    async def _bluetooth_down(self):
        tmp = tempfile.mkdtemp()
        ob.STATE_FILE = os.path.join(tmp, "state.json")
        ob.BLUETOOTH_RETRY_SECONDS = 0.05
        with open(os.path.join(tmp, "index.html"), "w") as f:
            f.write("<title>OpenStorm</title>")
        bridge = ob.Bridge(bluez=FlakyBluez(), link=FakeLink(), led=FakeLed(), updater=FakeUpdater())
        client = TestClient(TestServer(ob.make_web_app(bridge, tmp)))
        await client.start_server()
        try:
            ws = await client.ws_connect("/ws")

            async def ask(cmd):
                await ws.send_str(json.dumps(cmd))
                return json.loads((await ws.receive(timeout=2)).data)

            status = await ask({"cmd": "status"})
            self.assertEqual(status["bluetooth"], False)
            self.assertEqual((await ask({"cmd": "scan"}))["event"], "error")

            await asyncio.wait_for(bridge.start(), 2)
            self.assertEqual((await ask({"cmd": "status"}))["bluetooth"], True)
            self.assertEqual((await ask({"cmd": "scan"}))["event"], "devices")
            await ws.close()
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
