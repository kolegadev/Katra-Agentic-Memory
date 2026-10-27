"""Unit tests for the pure parts of the memory-growth check.

Run from this directory:  python3 -m unittest test_katra_memory_growth
"""
import unittest

from katra_memory_growth import top_delta, verdict_text


class VerdictTests(unittest.TestCase):
    def test_rows_without_propositions_are_not_no_activity(self):
        # D1: 1,375 rows arriving with no key must not read as a quiet window.
        self.assertIn("KEY NOT WRITTEN", verdict_text(1375, 0, 0))

    def test_no_activity_only_when_nothing_moved(self):
        self.assertIn("NO ACTIVITY", verdict_text(0, 0, 0))

    def test_flow_stemmed(self):
        self.assertIn("FLOW STEMMED", verdict_text(0, 0, 5))

    def test_absorption(self):
        self.assertIn("ABSORPTION WORKING", verdict_text(5, 2, 4))

    def test_review(self):
        self.assertIn("REVIEW", verdict_text(5, 4, 1))

    def test_compaction(self):
        self.assertIn("COMPACTION SEEN", verdict_text(-100, -5, 0))
        self.assertIn("COMPACTION SEEN", verdict_text(0, -5, 0))


class TopDeltaTests(unittest.TestCase):
    def test_dropped_entry_is_reported(self):
        # D2: an entry that leaves the top 6 must say so, not read as flat.
        out = top_delta(
            [{"text": "a", "occ": 10}, {"text": "b", "occ": 5}],
            [{"text": "c", "occ": 3}],
        )
        states = {d["text"]: d["state"] for d in out}
        self.assertEqual(states["b"], "dropped")
        self.assertEqual(states["c"], "new")

    def test_climbing_delta(self):
        out = top_delta([{"text": "a", "occ": 10}], [{"text": "a", "occ": 12}])
        self.assertEqual(out[0]["delta"], 2)
        self.assertEqual(out[0]["state"], "climbing")


if __name__ == "__main__":
    unittest.main()
