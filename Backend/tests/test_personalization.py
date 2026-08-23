"""Stdlib unittest coverage for the pure personalization logic (no Store/LLM needed).

Run from the master folder:  python -m unittest v4_claude.tests.test_personalization -v
(stdlib unittest, not pytest, to avoid adding a dependency — see CLAUDE.md.)
"""

import unittest

from ..personalization import (
    describe_user_context,
    summarize_user_context,
)


class SummarizeUserContextTests(unittest.TestCase):
    def test_new_customer_is_not_returning(self):
        ctx = summarize_user_context(None, None)
        self.assertFalse(ctx["is_returning"])
        self.assertEqual(ctx["recent_searches"], [])
        self.assertIsNone(ctx["last_order"])

    def test_searches_only_marks_returning(self):
        ctx = summarize_user_context(None, ["roses", "cake"])
        self.assertTrue(ctx["is_returning"])
        self.assertEqual(ctx["recent_searches"], ["roses", "cake"])

    def test_searches_capped_and_empties_dropped(self):
        ctx = summarize_user_context(None, ["a", "", "b", "c", "d", "e", "f"])
        self.assertEqual(ctx["recent_searches"], ["a", "b", "c", "d", "e"])  # MAX_CONTEXT_SEARCHES=5

    def test_last_order_item_names_extracted(self):
        order = {
            "order_ref": "ORD-1",
            "created_at": "2026-06-01T00:00:00Z",
            "cart": [
                {"product_id": "CAKE1", "name": "Chocolate Cake", "quantity": 1},
                {"product_id": "FLOWER1", "name": "Red Roses", "quantity": 2},
                {"product_id": "X", "quantity": 1},  # no name -> skipped from names
            ],
        }
        ctx = summarize_user_context(order, None)
        self.assertTrue(ctx["is_returning"])
        self.assertEqual(ctx["last_order"]["order_ref"], "ORD-1")
        self.assertEqual(ctx["last_order"]["item_names"], ["Chocolate Cake", "Red Roses"])
        self.assertTrue(ctx["last_order"]["has_cart"])

    def test_order_without_cart_still_returning_but_no_names(self):
        ctx = summarize_user_context({"order_ref": "ORD-2"}, None)
        self.assertTrue(ctx["is_returning"])
        self.assertEqual(ctx["last_order"]["item_names"], [])
        self.assertFalse(ctx["last_order"]["has_cart"])


class DescribeUserContextTests(unittest.TestCase):
    def test_none_is_new_customer(self):
        self.assertIn("new customer", describe_user_context(None))

    def test_not_returning_is_new_customer(self):
        self.assertIn("new customer", describe_user_context({"is_returning": False}))

    def test_describes_order_and_searches(self):
        ctx = summarize_user_context(
            {"order_ref": "ORD-1", "cart": [{"product_id": "CAKE1", "name": "Choc Cake", "quantity": 1}]},
            ["roses"],
        )
        text = describe_user_context(ctx)
        self.assertIn("Choc Cake", text)
        self.assertIn("roses", text)


if __name__ == "__main__":
    unittest.main()
