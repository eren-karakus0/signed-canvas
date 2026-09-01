"""The Python verifier against the same fixture the browser verifier runs.

ADR 0001 accepted two verifier implementations because both already existed and both were
already cross-checked. This file is what keeps that true: if the Python and the JS ever
disagree about the sweep, a did:key or a payload, one of them fails here.

    python -m pytest server/canvas/test_verifier.py
    python -m unittest discover -s server/canvas -p 'test_*.py'
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from verifier import (
    DidError,
    SweepError,
    fingerprint_of,
    message_payload,
    public_key_of,
    swept,
    verify_payload,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "test" / "vectors" / "technocore-318.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
MAX_CHARS = VECTORS["provenance"]["max_text_chars"]


def _from_code_points(points: list[int]) -> str:
    return "".join(chr(point) for point in points)


def _to_code_points(text: str) -> list[int]:
    return [ord(character) for character in text]


class SweepVectors(unittest.TestCase):
    def test_every_published_sweep_case(self) -> None:
        for vector in VECTORS["sweep_cases"]:
            with self.subTest(vector["name"]):
                text = _from_code_points(vector["in_cp"])
                if vector["raises_empty"]:
                    with self.assertRaises(SweepError):
                        swept(text, MAX_CHARS)
                    continue
                self.assertEqual(
                    _to_code_points(swept(text, MAX_CHARS)), vector["out_cp"]
                )

    def test_each_swept_character_becomes_its_own_space(self) -> None:
        # Stated apart from the vectors: collapsing runs reads as an improvement and signs a
        # string the server never stored.
        self.assertEqual(swept("a\r\nc"), "a  c")

    def test_refuses_text_over_the_cap(self) -> None:
        with self.assertRaises(SweepError):
            swept("x" * (MAX_CHARS + 1), MAX_CHARS)


class DidVectors(unittest.TestCase):
    def test_published_identities(self) -> None:
        for identity in VECTORS["identities"]:
            with self.subTest(identity["fingerprint"]):
                self.assertEqual(
                    fingerprint_of(identity["did"]), identity["fingerprint"]
                )
                self.assertIsNotNone(public_key_of(identity["did"]))

    def test_published_rejections(self) -> None:
        for vector in VECTORS["did_invalid"]:
            with self.subTest(vector["why"]):
                with self.assertRaises(DidError):
                    public_key_of(vector["did"])


class SignatureVectors(unittest.TestCase):
    def test_payload_bytes_match_the_fixture(self) -> None:
        for vector in VECTORS["signature_cases"]:
            with self.subTest(vector["name"]):
                payload = message_payload(
                    vector["room"],
                    vector["nonce"],
                    _from_code_points(vector["text_raw_cp"]),
                )
                self.assertEqual(payload, vector["payload_display"])
                self.assertEqual(
                    payload.encode("utf-8").hex(), vector["payload_utf8_hex"]
                )

    def test_canonical_signature_verifies(self) -> None:
        for vector in VECTORS["signature_cases"]:
            with self.subTest(vector["name"]):
                self.assertTrue(
                    verify_payload(
                        vector["did"],
                        vector["sig_canonical"],
                        vector["payload_display"],
                    )
                )

    def test_all_accepted_spellings_verify(self) -> None:
        for vector in VECTORS["signature_cases"]:
            for spelling in vector["sig_accepted_spellings"]:
                with self.subTest(vector["name"], ending=spelling[-4:]):
                    self.assertTrue(
                        verify_payload(
                            vector["did"], spelling, vector["payload_display"]
                        )
                    )

    def test_a_tampered_payload_does_not_verify(self) -> None:
        # The fixture says what must pass. What must fail is ours to assert, and it is the
        # half that matters: a verifier that returns True always passes every vector above.
        for vector in VECTORS["signature_cases"]:
            with self.subTest(vector["name"]):
                self.assertFalse(
                    verify_payload(
                        vector["did"],
                        vector["sig_canonical"],
                        vector["payload_display"] + "x",
                    )
                )

    def test_another_identity_does_not_verify(self) -> None:
        cases = VECTORS["signature_cases"]
        for vector in cases:
            other = next((c for c in cases if c["did"] != vector["did"]), None)
            if other is None:
                continue
            with self.subTest(vector["name"]):
                self.assertFalse(
                    verify_payload(
                        other["did"], vector["sig_canonical"], vector["payload_display"]
                    )
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
