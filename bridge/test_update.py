"""Tests checking, unpacking and installing update bundles on the bridge."""
import asyncio
import hashlib
import io
import os
import tarfile
import tempfile
import unittest

import openstorm_bridge as ob

COMPLETE = {
    "openstorm_bridge.py": "NEW = 2\n",
    "install-pi.sh": "echo installing\n",
    "VERSION": "v2\n",
    "www/index.html": "new",
}


def make_bundle(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    data = buffer.getvalue()
    return data, hashlib.sha256(data).hexdigest()


def read(path):
    with open(path) as f:
        return f.read()


class UnpackBundleTest(unittest.TestCase):
    def setUp(self):
        self.dest = os.path.join(tempfile.mkdtemp(), ".update")

    def test_unpacks_complete_bundle(self):
        data, sha = make_bundle(COMPLETE)
        ob.unpack_bundle(data, sha, self.dest)
        self.assertEqual(read(os.path.join(self.dest, "www", "index.html")), "new")
        self.assertEqual(ob.read_version(self.dest), "v2")

    def test_rejects_wrong_checksum(self):
        data, _ = make_bundle(COMPLETE)
        with self.assertRaises(ValueError):
            ob.unpack_bundle(data, "0" * 64, self.dest)

    def test_rejects_broken_bundles(self):
        missing_app = {k: v for k, v in COMPLETE.items() if k != "www/index.html"}
        missing_installer = {k: v for k, v in COMPLETE.items() if k != "install-pi.sh"}
        syntax_error = dict(COMPLETE, **{"openstorm_bridge.py": "def (:\n"})
        for files in (missing_app, missing_installer, syntax_error):
            data, sha = make_bundle(files)
            with self.assertRaises(Exception):
                ob.unpack_bundle(data, sha, self.dest)

    def test_version_defaults_to_dev(self):
        self.assertEqual(ob.read_version(tempfile.mkdtemp()), "dev")


class FakeServerUpdater(ob.Updater):
    """Serves a bundle from memory instead of GitHub."""

    def __init__(self, files, installer):
        super().__init__(app_dir=tempfile.mkdtemp(), installer=installer)
        self.bundle, sha = make_bundle(files)
        self.info = '{{"version": "v2", "sha256": "{}"}}'.format(sha).encode()

    async def _get(self, name):
        return self.info if name == "version.json" else self.bundle


class UpdaterTest(unittest.TestCase):
    def test_runs_installer_from_unpacked_bundle(self):
        seen = []

        async def installer(directory):
            seen.append(read(os.path.join(directory, "install-pi.sh")))

        updater = FakeServerUpdater(COMPLETE, installer)
        self.assertEqual(asyncio.run(updater.install()), "v2")
        self.assertEqual(seen, ["echo installing\n"])
        self.assertEqual(os.listdir(updater.app_dir), [])  # unpacked bundle is removed

    def test_reports_failed_installation(self):
        async def installer(directory):
            raise RuntimeError("Installation fehlgeschlagen: kein Netz")

        updater = FakeServerUpdater(COMPLETE, installer)
        with self.assertRaisesRegex(RuntimeError, "kein Netz"):
            asyncio.run(updater.install())
        self.assertEqual(os.listdir(updater.app_dir), [])

    def test_quick_update_when_system_files_are_unchanged(self):
        calls = []

        async def installer(directory):
            calls.append(directory)

        updater = FakeServerUpdater(COMPLETE, installer)
        bundle_dir = tempfile.mkdtemp()
        for name, text in COMPLETE.items():
            os.makedirs(os.path.dirname(os.path.join(bundle_dir, name)), exist_ok=True)
            with open(os.path.join(bundle_dir, name), "w") as f:
                f.write("changed" if name in ("openstorm_bridge.py", "www/index.html") else text)
        with open(os.path.join(updater.app_dir, "SYSTEM"), "w") as f:
            f.write(ob.system_fingerprint(bundle_dir) + "\n")  # as install-pi.sh writes it

        self.assertEqual(asyncio.run(updater.install()), "v2")
        self.assertEqual(calls, [])
        self.assertEqual(read(os.path.join(updater.app_dir, "openstorm_bridge.py")), "NEW = 2\n")
        self.assertEqual(read(os.path.join(updater.app_dir, "www", "index.html")), "new")
        self.assertEqual(ob.read_version(updater.app_dir), "v2")
        self.assertEqual(sorted(os.listdir(updater.app_dir)), ["SYSTEM", "VERSION", "openstorm_bridge.py", "www"])

    def test_fingerprint_ignores_app_and_tests_but_not_system_files(self):
        a, b = tempfile.mkdtemp(), tempfile.mkdtemp()
        for d, script, service in ((a, "x = 1", "A"), (b, "x = 2", "A")):
            os.makedirs(os.path.join(d, "www"))
            for name, text in (("openstorm_bridge.py", script), ("www/index.html", script),
                               ("test_web.py", script), ("bridge.service", service)):
                with open(os.path.join(d, name), "w") as f:
                    f.write(text)
        self.assertEqual(ob.system_fingerprint(a), ob.system_fingerprint(b))
        with open(os.path.join(b, "bridge.service"), "w") as f:
            f.write("B")
        self.assertNotEqual(ob.system_fingerprint(a), ob.system_fingerprint(b))

    def test_real_installer_reports_last_output_line(self):
        directory = tempfile.mkdtemp()
        with open(os.path.join(directory, "install-pi.sh"), "w") as f:
            f.write("echo step 1\necho 'E: Paket nicht gefunden' >&2\nexit 1\n")
        with self.assertRaisesRegex(RuntimeError, "Paket nicht gefunden"):
            asyncio.run(ob.run_installer(directory))


if __name__ == "__main__":
    unittest.main()
