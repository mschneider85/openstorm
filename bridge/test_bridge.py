import json
import unittest

from openstorm_bridge import LineBuffer, chunks, device_path, encode_event, is_ev3_class


class HelperTest(unittest.TestCase):
    def test_chunks(self):
        self.assertEqual(chunks(b"abcdefg", 3), [b"abc", b"def", b"g"])
        self.assertEqual(chunks(b""), [])
        self.assertTrue(all(len(c) <= 20 for c in chunks(bytes(100))))

    def test_line_buffer_reassembles_split_lines(self):
        buf = LineBuffer()
        self.assertEqual(buf.push(b'{"cmd":'), [])
        self.assertEqual(buf.push(b'"scan"}\n{"cmd":"st'), ['{"cmd":"scan"}'])
        self.assertEqual(buf.push(b'atus"}\n\n'), ['{"cmd":"status"}'])

    def test_event_roundtrip_through_chunks(self):
        event = {"event": "devices", "devices": [{"name": "EV3 Größe", "address": "00:16:53:AA:BB:CC"}]}
        buf = LineBuffer()
        lines = []
        for piece in chunks(encode_event(event)):
            lines += buf.push(piece)
        self.assertEqual([json.loads(l) for l in lines], [event])

    def test_ev3_class(self):
        self.assertTrue(is_ev3_class(0x000804))
        self.assertFalse(is_ev3_class(0x5A020C))  # smartphone
        self.assertFalse(is_ev3_class(None))

    def test_device_path(self):
        self.assertEqual(device_path("00:16:53:aa:bb:cc"), "/org/bluez/hci0/dev_00_16_53_AA_BB_CC")


if __name__ == "__main__":
    unittest.main()
