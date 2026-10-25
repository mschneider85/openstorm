"""Tests the WLAN setup of the bridge against a fake NetworkManager (nmcli)."""
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
from test_web import FakeBluez, FakeLed, FakeLink, FakeUpdater


def esc(value):
    return value.replace("\\", "\\\\").replace(":", "\\:")


class FakeNmcli:
    """Profiles, the active one and the networks in range, answering like `nmcli -t`."""

    def __init__(self, in_range=("Zuhause", "Nachbar:5G")):
        self.profiles = {ob.HOTSPOT: {"ssid": ob.HOTSPOT_SSID, "mode": "ap", "psk": "openstorm"}}
        self.active = ""
        self.in_range = list(in_range)
        self.passwords = {}  # ssid -> the right password
        self.calls = []

    async def __call__(self, *args, timeout=30):
        self.calls.append(args)
        args = [a for a in args if a not in ("-t",)]
        if args[:2] == ["--wait", "45"] or args[:2] == ["--wait", "30"]:
            args = args[2:]
        if args[:2] == ["-f", "GENERAL.CONNECTION"]:
            return "GENERAL.CONNECTION:{}\n".format(esc(self.active) or "--")
        if args[:2] == ["-f", "NAME,TYPE"]:
            return "".join("{}:802-11-wireless\n".format(esc(n)) for n in self.profiles)
        if args[:1] == ["-f"] and args[1].startswith("802-11-wireless"):
            p = self.profiles[args[-1]]
            return "802-11-wireless.ssid:{}\n802-11-wireless.mode:{}\n".format(esc(p["ssid"]), p["mode"])
        if args[:2] == ["-f", "SSID,SIGNAL,SECURITY"]:
            if self.active == ob.HOTSPOT:
                return ""
            return "".join("{}:{}:WPA2\n".format(esc(s), 80 - 10 * i) for i, s in enumerate(self.in_range))
        if args[:2] == ["connection", "add"]:
            opts = dict(zip(args[2::2], args[3::2]))
            self.profiles[opts["con-name"]] = {"ssid": opts["ssid"], "mode": "infrastructure",
                                               "psk": opts.get("wifi-sec.psk", "")}
            return ""
        if args[:2] == ["connection", "delete"]:
            del self.profiles[args[2]]
            if self.active == args[2]:
                self.active = ""
            return ""
        if args[:2] == ["connection", "up"]:
            p = self.profiles[args[2]]
            if p["mode"] != "ap" and (p["ssid"] not in self.in_range or
                                      self.passwords.get(p["ssid"], p["psk"]) != p["psk"]):
                self.active = ""
                raise RuntimeError("Error: Connection activation failed: Secrets were required")
            self.active = args[2]
            return ""
        raise AssertionError("unexpected nmcli {}".format(args))


class TerseTest(unittest.TestCase):
    def test_escaped_fields(self):
        self.assertEqual(ob.split_terse(r"Nachbar\:5G:70:WPA2"), ["Nachbar:5G", "70", "WPA2"])
        self.assertEqual(ob.terse_values("GENERAL.CONNECTION:Mein\\:Netz\n"), {"GENERAL.CONNECTION": "Mein:Netz"})

    def test_networks_once_strongest_first_without_own(self):
        text = "Zuhause:40:WPA2\nGast:90:\nZuhause:70:WPA2\n:50:WPA2\nOpenStorm:99:WPA2\n"
        self.assertEqual(ob.parse_networks(text), [
            {"ssid": "Gast", "signal": 90, "secure": False},
            {"ssid": "Zuhause", "signal": 70, "secure": True},
        ])

    def test_own_hosts(self):
        for host in ("openstorm.local", "openstorm-2.local", "openstorm", "10.42.0.1", "192.168.0.64", None):
            self.assertTrue(ob.is_own_host(host), host)
        for host in ("captive.apple.com", "connectivitycheck.gstatic.com", "www.msftconnecttest.com"):
            self.assertFalse(ob.is_own_host(host), host)


class WlanTest(unittest.TestCase):
    def setUp(self):
        ob.SWITCH_DELAY_SECONDS = 0
        ob.FALLBACK_SECONDS = 0

    def test_setup_from_own_network(self):
        async def run():
            nm = FakeNmcli()
            nm.active = ob.HOTSPOT
            nm.passwords["Zuhause"] = "geheim123"
            tmp = tempfile.mkdtemp()
            cache = os.path.join(tmp, "networks")
            with open(cache, "w") as f:
                f.write("Zuhause:60:WPA2\n")
            wlan = ob.Wlan(nm, cache)
            self.assertEqual((await wlan.status())["mode"], "hotspot")
            # While the Pi shows its own network, the list from boot is used.
            self.assertEqual([n["ssid"] for n in await wlan.networks()], ["Zuhause"])

            # A wrong password: back to the own network, with a message.
            self.assertTrue(await wlan.join("Zuhause", "falsch123"))
            await asyncio.sleep(0.05)
            status = await wlan.status()
            self.assertEqual(status["mode"], "hotspot")
            self.assertIn("Passwort", status["error"])
            self.assertEqual(await wlan.saved(), [])

            self.assertTrue(await wlan.join("Zuhause", "geheim123"))
            self.assertEqual((await wlan.status())["joining"], "Zuhause")
            await asyncio.sleep(0.05)
            status = await wlan.status()
            self.assertEqual((status["mode"], status["ssid"], status["error"]), ("client", "Zuhause", None))
            self.assertEqual(await wlan.saved(), [{"name": "Zuhause", "ssid": "Zuhause", "active": True}])
        asyncio.run(run())

    def test_changing_the_password_of_the_current_network(self):
        async def run():
            nm = FakeNmcli()
            nm.profiles["Zuhause"] = {"ssid": "Zuhause", "mode": "infrastructure", "psk": "alt12345"}
            nm.active = "Zuhause"
            nm.passwords["Zuhause"] = "neu123456"
            wlan = ob.Wlan(nm, "/nonexistent")
            self.assertTrue(await wlan.join("Zuhause", "neu123456"))
            await asyncio.sleep(0.05)
            self.assertEqual(await wlan.saved(), [{"name": "Zuhause (neu)", "ssid": "Zuhause", "active": True}])
        asyncio.run(run())

    def test_network_out_of_range_is_only_stored(self):
        async def run():
            nm = FakeNmcli()
            nm.profiles["Zuhause"] = {"ssid": "Zuhause", "mode": "infrastructure", "psk": "x" * 8}
            nm.active = "Zuhause"
            wlan = ob.Wlan(nm, "/nonexistent")
            self.assertFalse(await wlan.join("Schule", "schule123"))
            self.assertEqual(nm.active, "Zuhause")
            self.assertEqual([s["ssid"] for s in await wlan.saved()], ["Zuhause", "Schule"])
        asyncio.run(run())

    def test_forgetting_the_current_network_opens_the_own(self):
        async def run():
            nm = FakeNmcli()
            nm.profiles["Zuhause"] = {"ssid": "Zuhause", "mode": "infrastructure", "psk": "x" * 8}
            nm.active = "Zuhause"
            wlan = ob.Wlan(nm, os.path.join(tempfile.mkdtemp(), "run", "networks"))
            with self.assertRaises(RuntimeError):
                await wlan.forget(ob.HOTSPOT)
            await wlan.forget("Zuhause")
            self.assertEqual(nm.active, ob.HOTSPOT)
            self.assertEqual(await wlan.saved(), [])
            # The networks from before, although the Pi cannot scan now.
            self.assertEqual([n["ssid"] for n in await wlan.networks()], ["Zuhause", "Nachbar:5G"])
        asyncio.run(run())

    def test_checks_input(self):
        async def run():
            wlan = ob.Wlan(FakeNmcli(), "/nonexistent")
            for ssid, password in (("", ""), ("x" * 33, ""), ("Zuhause", "kurz")):
                with self.assertRaises(RuntimeError):
                    await wlan.join(ssid, password)
        asyncio.run(run())


@unittest.skipIf(aiohttp is None, "aiohttp not installed")
class CaptiveTest(unittest.TestCase):
    def test_setup_page_and_captive_portal(self):
        asyncio.run(self._portal())

    async def _portal(self):
        ob.SWITCH_DELAY_SECONDS = 0
        tmp = tempfile.mkdtemp()
        ob.STATE_FILE = os.path.join(tmp, "state.json")
        with open(os.path.join(tmp, "wlan.html"), "w") as f:
            f.write("<title>OpenStorm – WLAN</title>")
        nm = FakeNmcli()
        nm.active = ob.HOTSPOT
        bridge = ob.Bridge(bluez=FakeBluez(), link=FakeLink(), led=FakeLed(), updater=FakeUpdater())
        client = TestClient(TestServer(ob.make_web_app(bridge, tmp, ob.Wlan(nm, "/nonexistent"), tmp)))
        await client.start_server()
        try:
            self.assertIn("WLAN", await (await client.get("/wlan")).text())

            # The iPad's internet check gets the setup page ...
            apple = {"Host": "captive.apple.com"}
            check = await client.get("/hotspot-detect.html", headers=apple, allow_redirects=False)
            self.assertEqual((check.status, check.headers["Location"]), (302, "http://10.42.0.1/wlan"))

            # ... until the device chooses to go on without a home network.
            self.assertEqual((await client.post("/api/wlan/stay", data="{}")).status, 415)
            self.assertEqual((await client.post("/api/wlan/stay", json={})).status, 200)
            check = await client.get("/hotspot-detect.html", headers=apple, allow_redirects=False)
            self.assertEqual(await check.text(), ob.APPLE_SUCCESS)
            android = await client.get("/generate_204", headers={"Host": "connectivitycheck.gstatic.com"})
            self.assertEqual(android.status, 204)

            status = await (await client.get("/api/wlan")).json()
            self.assertEqual((status["mode"], status["saved"]), ("hotspot", []))

            bad = await client.post("/api/wlan/join", json={"ssid": "Zuhause", "password": "kurz"})
            self.assertEqual((bad.status, (await bad.json())["error"]), (400, "Ein WLAN-Passwort hat 8 bis 63 Zeichen."))
            joined = await client.post("/api/wlan/join", json={"ssid": "Zuhause", "password": "geheim123"})
            self.assertEqual(await joined.json(), {"switching": True})
            await asyncio.sleep(0.05)
            status = await (await client.get("/api/wlan")).json()
            self.assertEqual((status["mode"], status["ssid"]), ("client", "Zuhause"))
            networks = await (await client.get("/api/wlan/networks")).json()
            self.assertEqual(networks["networks"][0]["ssid"], "Zuhause")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
