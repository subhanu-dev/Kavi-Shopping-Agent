"""Tests for the UI-action routing consolidation: the [ui_action:...] event-message
parser and its round-trip with UiAction.to_event_message. These guard the contract that
master_router_node relies on to short-circuit button/form clicks to the right specialist
without an LLM call.

Deliberately imports only from schemas (no agent.py) so the suite stays free of model
instantiation / API-key requirements. The action_type -> agent mapping (_UI_ACTION_AGENT)
is exercised by the live graph verification, not here.

Run with: python -m unittest v4_claude.tests.test_actions -v
"""

import json
import unittest

from typing import get_args

from ..schemas import UiAction, UiActionType, parse_ui_action_type


class ParseUiActionTypeTests(unittest.TestCase):
    def test_extracts_simple_action(self):
        self.assertEqual(
            parse_ui_action_type("[ui_action:add_to_cart] {}"), "add_to_cart"
        )

    def test_extracts_with_json_payload(self):
        msg = '[ui_action:checkout_form_submit] {"recipient": {"name": "Amal"}}'
        self.assertEqual(parse_ui_action_type(msg), "checkout_form_submit")

    def test_non_ui_action_message_returns_none(self):
        self.assertIsNone(parse_ui_action_type("add that to my cart please"))

    def test_empty_string_returns_none(self):
        self.assertIsNone(parse_ui_action_type(""))

    def test_none_returns_none(self):
        self.assertIsNone(parse_ui_action_type(None))

    def test_non_string_returns_none(self):
        # Gemini sometimes hands back list-shaped content; must not raise.
        self.assertIsNone(parse_ui_action_type(["[ui_action:add_to_cart] {}"]))

    def test_prefix_without_closing_bracket_is_tolerated(self):
        # Malformed but starts with the prefix — return whatever's there, not a crash.
        self.assertEqual(parse_ui_action_type("[ui_action:add_to_cart"), "add_to_cart")


class RoundTripTests(unittest.TestCase):
    def test_every_action_type_round_trips(self):
        # The core guarantee: anything to_event_message emits, parse can recover.
        for action_type in get_args(UiActionType):
            msg = UiAction(action_type=action_type, payload={"k": "v"}).to_event_message()
            self.assertEqual(parse_ui_action_type(msg), action_type)

    def test_round_trip_with_empty_payload(self):
        msg = UiAction(action_type="clear_cart").to_event_message()
        self.assertEqual(parse_ui_action_type(msg), "clear_cart")

    def test_payload_with_special_chars_does_not_break_parse(self):
        # A gift message with a "]" in it must not confuse the action-type split.
        payload = {"gift_message": "Happy bday]! enjoy"}
        msg = UiAction(action_type="checkout_form_submit", payload=payload).to_event_message()
        self.assertEqual(parse_ui_action_type(msg), "checkout_form_submit")
        # And the payload is still valid JSON after the "] " separator.
        json_part = msg.split("] ", 1)[1]
        self.assertEqual(json.loads(json_part)["gift_message"], "Happy bday]! enjoy")


if __name__ == "__main__":
    unittest.main()
