"""Light automated tests on the checkout gate — the riskiest, easiest-to-silently-break
logic in this build: canonical city resolution, the create_order readiness gate, and the
error-code-to-friendly-message mapping. Stdlib unittest (no pytest dependency added).

Run with: python -m unittest v4_claude.tests.test_checkout -v
"""

import unittest

from ..checkout import (
    build_create_order_payload,
    describe_missing_fields,
    find_perishable_product_id,
    is_ready_for_order,
    merge_checkout,
    parse_create_order_error,
    reduce_checkout,
    resolve_canonical_city,
)


class ResolveCanonicalCityTests(unittest.TestCase):
    def test_single_result_is_canonical(self):
        cities = [{"name": "Galle", "aliases": []}]
        canonical, candidates = resolve_canonical_city("galle", cities)
        self.assertEqual(canonical, "Galle")
        self.assertEqual(candidates, ["Galle"])

    def test_exact_match_among_multiple_is_canonical(self):
        cities = [
            {"name": "Colombo 01", "aliases": []},
            {"name": "Colombo 03", "aliases": ["Kollupitiya"]},
            {"name": "Colombo 05", "aliases": []},
        ]
        canonical, _ = resolve_canonical_city("Colombo 03", cities)
        self.assertEqual(canonical, "Colombo 03")

    def test_exact_alias_match_is_canonical(self):
        cities = [
            {"name": "Colombo 03", "aliases": ["Kollupitiya"]},
            {"name": "Colombo 05", "aliases": []},
        ]
        canonical, _ = resolve_canonical_city("kollupitiya", cities)
        self.assertEqual(canonical, "Colombo 03")

    def test_ambiguous_partial_match_is_not_canonical(self):
        cities = [
            {"name": "Colombo 01", "aliases": []},
            {"name": "Colombo 02", "aliases": []},
            {"name": "Colombo 03", "aliases": []},
        ]
        canonical, candidates = resolve_canonical_city("colombo", cities)
        self.assertIsNone(canonical)
        self.assertEqual(len(candidates), 3)

    def test_no_results_means_no_canonical(self):
        canonical, candidates = resolve_canonical_city("nonexistentville", [])
        self.assertIsNone(canonical)
        self.assertEqual(candidates, [])


class FindPerishableProductIdTests(unittest.TestCase):
    def test_finds_cake_case_insensitive(self):
        cart = [{"product_id": "flower00fl001", "name": "Roses", "quantity": 1},
                {"product_id": "cake00ka002034", "name": "Cake", "quantity": 1}]
        self.assertEqual(find_perishable_product_id(cart), "flower00fl001")

    def test_returns_none_when_no_perishables(self):
        cart = [{"product_id": "toy00xx001", "name": "Teddy Bear", "quantity": 1}]
        self.assertIsNone(find_perishable_product_id(cart))

    def test_empty_cart(self):
        self.assertIsNone(find_perishable_product_id([]))


class MergeCheckoutTests(unittest.TestCase):
    def test_merges_into_empty_checkout(self):
        result = merge_checkout(None, {"recipient": {"name": "Amal"}})
        self.assertEqual(result["recipient"]["name"], "Amal")

    def test_merges_without_clobbering_other_fields_in_section(self):
        checkout = {"recipient": {"name": "Amal"}}
        result = merge_checkout(checkout, {"recipient": {"phone": "0771234567"}})
        self.assertEqual(result["recipient"], {"name": "Amal", "phone": "0771234567"})

    def test_none_values_in_patch_are_ignored(self):
        checkout = {"recipient": {"name": "Amal"}}
        result = merge_checkout(checkout, {"recipient": {"name": None, "phone": "0771234567"}})
        self.assertEqual(result["recipient"], {"name": "Amal", "phone": "0771234567"})

    def test_does_not_mutate_input(self):
        checkout = {"recipient": {"name": "Amal"}}
        merge_checkout(checkout, {"recipient": {"phone": "0771234567"}})
        self.assertEqual(checkout, {"recipient": {"name": "Amal"}})


class IsReadyForOrderTests(unittest.TestCase):
    FULL_CHECKOUT = {
        "recipient": {"name": "Amal", "phone": "0771234567"},
        "delivery": {"address": "123 Lake Rd", "city": "Colombo 05", "date": "2026-06-25"},
        "sender": {"name": "Nimal"},
    }

    def test_empty_cart_blocks(self):
        ready, reason = is_ready_for_order([], self.FULL_CHECKOUT, True)
        self.assertFalse(ready)
        self.assertIn("empty", reason.lower())

    def test_missing_fields_block(self):
        ready, reason = is_ready_for_order(
            [{"product_id": "cake001", "name": "Cake", "quantity": 1}], {}, True
        )
        self.assertFalse(ready)
        self.assertIn("recipient", reason.lower())

    def test_unconfirmed_delivery_blocks(self):
        ready, reason = is_ready_for_order(
            [{"product_id": "cake001", "name": "Cake", "quantity": 1}],
            self.FULL_CHECKOUT,
            False,
        )
        self.assertFalse(ready)
        self.assertIn("delivery", reason.lower())

    def test_everything_present_is_ready(self):
        ready, reason = is_ready_for_order(
            [{"product_id": "cake001", "name": "Cake", "quantity": 1}],
            self.FULL_CHECKOUT,
            True,
        )
        self.assertTrue(ready)
        self.assertIsNone(reason)


class BuildCreateOrderPayloadTests(unittest.TestCase):
    def test_builds_expected_shape(self):
        cart = [{"product_id": "cake001", "name": "Cake", "quantity": 2, "icing_text": "Happy Birthday"}]
        checkout = {
            "recipient": {"name": "Amal", "phone": "0771234567"},
            "delivery": {"address": "123 Lake Rd", "city": "Colombo 05", "date": "2026-06-25"},
            "sender": {"name": "Nimal", "anonymous": False},
        }
        payload = build_create_order_payload(cart, checkout)
        self.assertEqual(payload["cart"], [{"product_id": "cake001", "quantity": 2, "icing_text": "Happy Birthday"}])
        self.assertEqual(payload["recipient"], {"name": "Amal", "phone": "+94771234567"})
        self.assertEqual(payload["delivery"]["location_type"], "house")
        self.assertEqual(payload["response_format"], "json")

    def test_omits_empty_icing_text_and_instructions(self):
        cart = [{"product_id": "flower001", "name": "Roses", "quantity": 1}]
        checkout = {
            "recipient": {"name": "Amal", "phone": "0771234567"},
            "delivery": {"address": "123 Lake Rd", "city": "Colombo 05", "date": "2026-06-25"},
            "sender": {"name": "Nimal"},
        }
        payload = build_create_order_payload(cart, checkout)
        self.assertNotIn("icing_text", payload["cart"][0])
        self.assertNotIn("instructions", payload["delivery"])


class ParseCreateOrderErrorTests(unittest.TestCase):
    def test_known_code_maps_to_friendly_message(self):
        code, message = parse_create_order_error("Error (city_not_deliverable): City XYZ not in service area")
        self.assertEqual(code, "city_not_deliverable")
        self.assertNotIn("XYZ", message)
        self.assertIn("deliver", message.lower())

    def test_unknown_code_gets_generic_friendly_message(self):
        code, message = parse_create_order_error("Error (some_new_code): details")
        self.assertEqual(code, "some_new_code")
        self.assertIn("try again", message.lower())

    def test_unparseable_text_gets_generic_message_and_no_code(self):
        code, message = parse_create_order_error("a stack trace or other raw text")
        self.assertIsNone(code)
        self.assertIn("try again", message.lower())


class ReduceCheckoutTests(unittest.TestCase):
    """The checkout-channel reducer. The critical guarantee: an explicit None write must
    RESET checkout (so place_order success and cart-clear can actually end a checkout) —
    the previous behaviour kept the old value on a None write, making checkout impossible
    to clear and leaving the delivery form stuck over an emptied cart."""

    def test_none_write_resets_checkout(self):
        existing = {"delivery": {"city": "Colombo", "address": "1 Lake Rd"}}
        self.assertIsNone(reduce_checkout(existing, None))

    def test_none_write_resets_even_when_left_is_none(self):
        self.assertIsNone(reduce_checkout(None, None))

    def test_dict_write_onto_none_returns_that_dict(self):
        result = reduce_checkout(None, {"recipient": {"name": "Amal"}})
        self.assertEqual(result, {"recipient": {"name": "Amal"}})

    def test_two_dict_writes_deep_merge(self):
        left = {"recipient": {"name": "Amal"}}
        right = {"delivery": {"city": "Colombo"}}
        result = reduce_checkout(left, right)
        self.assertEqual(result["recipient"], {"name": "Amal"})
        self.assertEqual(result["delivery"], {"city": "Colombo"})


if __name__ == "__main__":
    unittest.main()
