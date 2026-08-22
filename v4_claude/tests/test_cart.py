"""Light automated tests on the cart-driven recommendation logic added in Sprint 5:
the complementary-product affinity lookup and the suggested-next-step routing fix.
Stdlib unittest (no pytest dependency added).

Run with: python -m unittest v4_claude.tests.test_cart -v
"""

import unittest

from ..cart import COMPLEMENTARY_AFFINITY, compute_suggested_next_step, find_complementary_suggestion, resolve_catalog_item

_STOPWORDS = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it"}


def _item(product_id: str) -> dict:
    return {"product_id": product_id, "name": product_id, "quantity": 1}


class FindComplementarySuggestionTests(unittest.TestCase):
    def test_cake_in_cart_suggests_flowers(self):
        cart = [_item("cake00ka002034")]
        result = find_complementary_suggestion(cart, set())
        self.assertEqual(result, ("CAKE", "flowers", "Flowers"))

    def test_case_insensitive_product_id(self):
        cart = [_item("CAKE00KA002034")]
        result = find_complementary_suggestion(cart, set())
        self.assertEqual(result[0], "CAKE")

    def test_already_cross_sold_prefix_is_skipped(self):
        cart = [_item("cake00ka002034")]
        result = find_complementary_suggestion(cart, {"CAKE"})
        self.assertIsNone(result)

    def test_empty_cart_returns_none(self):
        self.assertIsNone(find_complementary_suggestion([], set()))

    def test_no_affinity_match_returns_none(self):
        cart = [_item("toy00xx001")]
        self.assertIsNone(find_complementary_suggestion(cart, set()))

    def test_multi_item_cart_returns_first_matching_prefix(self):
        cart = [_item("toy00xx001"), _item("flower00fl001"), _item("cake00ka002034")]
        result = find_complementary_suggestion(cart, set())
        self.assertEqual(result[0], "FLOWER")

    def test_multi_item_cart_skips_already_cross_sold_to_find_next(self):
        cart = [_item("cake00ka002034"), _item("flower00fl001")]
        result = find_complementary_suggestion(cart, {"CAKE"})
        self.assertEqual(result[0], "FLOWER")

    def test_affinity_table_values_are_valid_search_terms(self):
        for prefix, (search_term, label) in COMPLEMENTARY_AFFINITY.items():
            self.assertGreaterEqual(len(search_term), 3, f"{prefix}'s search term too short")
            self.assertLessEqual(len(search_term), 200, f"{prefix}'s search term too long")
            words = set(search_term.lower().split())
            self.assertTrue(
                words - _STOPWORDS, f"{prefix}'s search term '{search_term}' is pure stopwords"
            )
            self.assertTrue(label, f"{prefix} is missing a display label")


class ComputeSuggestedNextStepTests(unittest.TestCase):
    def test_empty_cart_is_none(self):
        self.assertIsNone(compute_suggested_next_step([], None, False))

    def test_single_item_is_add_more(self):
        cart = [_item("cake00ka002034")]
        self.assertEqual(compute_suggested_next_step(cart, None, False), "add_more")

    def test_two_plus_items_is_proceed_to_checkout(self):
        cart = [_item("cake00ka002034"), _item("flower00fl001")]
        self.assertEqual(compute_suggested_next_step(cart, None, False), "proceed_to_checkout")

    def test_fresh_product_cards_override_proceed_to_checkout(self):
        cart = [_item("cake00ka002034"), _item("flower00fl001")]
        result = compute_suggested_next_step(cart, None, False, has_fresh_product_cards=True)
        self.assertEqual(result, "add_more")

    def test_fresh_product_cards_irrelevant_below_threshold(self):
        cart = [_item("cake00ka002034")]
        result = compute_suggested_next_step(cart, None, False, has_fresh_product_cards=True)
        self.assertEqual(result, "add_more")

    def test_fresh_product_cards_irrelevant_on_empty_cart(self):
        result = compute_suggested_next_step([], None, False, has_fresh_product_cards=True)
        self.assertIsNone(result)

    def test_fresh_product_cards_does_not_leak_into_checkout_branch(self):
        cart = [_item("cake00ka002034"), _item("flower00fl001")]
        checkout = {"recipient": {"name": "Amal", "phone": "+94771234567"}}
        result = compute_suggested_next_step(
            cart, checkout, False, has_fresh_product_cards=True
        )
        self.assertEqual(result, "continue_checkout")

    def test_checkout_complete_and_delivery_confirmed_is_none(self):
        cart = [_item("cake00ka002034")]
        checkout = {
            "recipient": {"name": "Amal", "phone": "+94771234567"},
            "delivery": {"address": "123 Galle Rd", "city": "Colombo 03", "date": "2026-06-25"},
            "sender": {"name": "Nimal"},
        }
        result = compute_suggested_next_step(
            cart, checkout, True, has_fresh_product_cards=True
        )
        self.assertIsNone(result)

    def test_empty_cart_with_stale_checkout_is_none(self):
        # Regression: an emptied cart must never suggest "continue_checkout" just because a
        # stale checkout dict is still around (the empty-cart check runs before the checkout
        # branch). Pairs with the cart-clear fix that resets checkout to None.
        stale_checkout = {"delivery": {"city": "Colombo", "address": "1 Lake Rd"}}
        result = compute_suggested_next_step([], stale_checkout, False)
        self.assertIsNone(result)


class ResolveCatalogItemTests(unittest.TestCase):
    def test_top_level_match(self):
        vp = {"123": {"id": "123", "name": "Cake", "price": {"amount": 500, "currency": "LKR"}}}
        res = resolve_catalog_item(vp, "123")
        self.assertEqual(res["name"], "Cake")

    def test_variant_match_synthesizes_name_and_extracts_price(self):
        vp = {"123": {"id": "123", "name": "Cake", "images": ["img1.jpg"], "variants": [{"id": "123-M", "name": "Medium", "price": {"amount": 1000, "currency": "LKR"}}]}}
        res = resolve_catalog_item(vp, "123-M")
        self.assertEqual(res["name"], "Cake (Medium)")
        self.assertEqual(res["price"]["amount"], 1000)
        self.assertEqual(res["images"], ["img1.jpg"])

    def test_no_match_returns_none(self):
        vp = {"123": {"id": "123", "name": "Cake"}}
        res = resolve_catalog_item(vp, "999")
        self.assertIsNone(res)

    def test_single_variant_resolves_to_lone_variant_id_and_price(self):
        # add_to_cart rewrites a single-variant product_id to the lone variant's id before
        # resolving; this proves that id resolves to the variant's own name/price, not a size prompt.
        vp = {"flowers00T2128": {"id": "flowers00T2128", "name": "Rosy Harmony Bloom", "images": ["img1.jpg"], "variants": [{"id": "flowers00T2128_default", "name": "", "price": {"amount": 4310, "currency": "LKR"}}]}}
        res = resolve_catalog_item(vp, "flowers00T2128_default")
        self.assertEqual(res["id"], "flowers00T2128_default")
        self.assertEqual(res["name"], "Rosy Harmony Bloom")
        self.assertEqual(res["price"]["amount"], 4310)

    def test_same_id_refetched_with_different_currency(self):
        # Proves last-write-wins replacing works at the dict level when simulated
        vp = {"123": {"id": "123", "name": "Cake", "price": {"amount": 5, "currency": "USD"}}}
        vp["123"] = {"id": "123", "name": "Cake", "price": {"amount": 1500, "currency": "LKR"}}
        res = resolve_catalog_item(vp, "123")
        self.assertEqual(res["price"]["currency"], "LKR")
        self.assertEqual(res["price"]["amount"], 1500)


if __name__ == "__main__":
    unittest.main()