"""Tests installing update bundles on the bridge."""
import hashlib
import io
import os
import tarfile
import tempfile
import unittest

import openstorm_bridge as ob


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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def read(path):
    with open(path) as f:
        return f.read()


class InstallBundleTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        write(os.path.join(self.dir, "openstorm_bridge.py"), "OLD = 1\n")
        write(os.path.join(self.dir, "VERSION"), "v1\n")
        write(os.path.join(self.dir, "www", "index.html"), "old")
        write(os.path.join(self.dir, "www", "old.js"), "old")

    def test_replaces_script_version_and_app(self):
        data, sha = make_bundle({
            "openstorm_bridge.py": "NEW = 2\n",
            "VERSION": "v2\n",
            "www/index.html": "new",
        })
        ob.install_bundle(data, sha, self.dir)
        self.assertEqual(read(os.path.join(self.dir, "openstorm_bridge.py")), "NEW = 2\n")
        self.assertEqual(ob.read_version(self.dir), "v2")
        self.assertEqual(read(os.path.join(self.dir, "www", "index.html")), "new")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "www", "old.js")))
        self.assertEqual(sorted(os.listdir(self.dir)), ["VERSION", "openstorm_bridge.py", "www"])

    def test_rejects_wrong_checksum(self):
        data, _ = make_bundle({"openstorm_bridge.py": "", "VERSION": "v2", "www/index.html": ""})
        with self.assertRaises(ValueError):
            ob.install_bundle(data, "0" * 64, self.dir)
        self.assertEqual(ob.read_version(self.dir), "v1")

    def test_keeps_old_version_if_bundle_is_broken(self):
        for files in (
            {"openstorm_bridge.py": "x = 1\n", "VERSION": "v2"},  # no app
            {"openstorm_bridge.py": "def (:\n", "VERSION": "v2", "www/index.html": ""},  # syntax error
        ):
            data, sha = make_bundle(files)
            with self.assertRaises(Exception):
                ob.install_bundle(data, sha, self.dir)
            self.assertEqual(read(os.path.join(self.dir, "openstorm_bridge.py")), "OLD = 1\n")
            self.assertEqual(read(os.path.join(self.dir, "www", "index.html")), "old")
            self.assertFalse(os.path.exists(os.path.join(self.dir, ".update")))

    def test_version_defaults_to_dev(self):
        self.assertEqual(ob.read_version(tempfile.mkdtemp()), "dev")


if __name__ == "__main__":
    unittest.main()
