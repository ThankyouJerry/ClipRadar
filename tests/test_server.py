import unittest

from server import calculate_confidence


def moment(chat_spike, keyword_spike):
    return {
        "metrics": {
            "chatSpike": chat_spike,
            "keywordSpike": keyword_spike,
        }
    }


class ConfidenceTests(unittest.TestCase):
    def test_empty_candidates_have_zero_confidence(self):
        self.assertEqual(calculate_confidence([]), 0)

    def test_strong_aligned_signals_can_reach_one_hundred(self):
        self.assertEqual(calculate_confidence([moment(3.2, 3.4)]), 100)

    def test_good_aligned_signals_are_in_good_range(self):
        self.assertEqual(calculate_confidence([moment(2.1, 2.2)]), 85)

    def test_single_strong_signal_is_penalized(self):
        aligned = calculate_confidence([moment(3.0, 3.0)])
        unbalanced = calculate_confidence([moment(3.0, 1.0)])
        self.assertLess(unbalanced, aligned)
        self.assertEqual(unbalanced, 51)

    def test_multiple_candidates_are_averaged(self):
        self.assertEqual(
            calculate_confidence([moment(3.0, 3.0), moment(2.0, 2.0)]),
            92,
        )


if __name__ == "__main__":
    unittest.main()
