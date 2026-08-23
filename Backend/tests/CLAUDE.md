# Tests — agent guide

This folder holds the automated test suite for the Kavi agent (the `v4_claude` package).

## How to run (IMPORTANT)
Always run from the **master folder** (`C:\Data Projects\Kapruka_ai_agent`, the parent of
`v4_claude`), using the master `.venv` — never from inside `v4_claude/` and never from inside
`tests/`. The tests use package-relative imports (`from ..checkout import ...`) and the project
is a PEP 420 **namespace package** (there is intentionally **no `__init__.py`** anywhere),
so the module path matters.

Run the whole suite:
```
.\.venv\Scripts\python.exe -m unittest v4_claude.tests.test_actions v4_claude.tests.test_cart v4_claude.tests.test_checkout v4_claude.tests.test_personalization
```

Run one file:
```
.\.venv\Scripts\python.exe -m unittest v4_claude.tests.test_checkout -v
```

`python -m unittest discover` does **not** work here (it needs `__init__.py`, which we omit on
purpose). Do not add `__init__.py` to "fix" discovery, and do not switch the run command to
discovery — use the explicit module paths above.

## Hard rules
- **Stdlib `unittest` only — never add `pytest`** or any other test dependency. Dependencies
  for this project live in the master folder; keeping tests dependency-free is deliberate.
- **No LLM / API keys / network / Store / DB in tests.** Every test here exercises *pure,
  deterministic* logic (cart math, checkout gate, city resolution, card/event parsing,
  personalization summaries). A test must pass offline with no env vars set.
- Behavior that genuinely needs the live graph or real Gemini (routing judgment, end-to-end
  conversation flows) is verified with **throwaway scripts run once and deleted**, not with
  committed tests — that's the established pattern in this codebase. Do not try to wire model
  calls into this suite.

## Import convention
Tests live in `v4_claude/tests/`, so import the code under test from the **parent** package:
```python
from ..checkout import is_ready_for_order      # correct
from ..cart import compute_suggested_next_step
from ..schemas import parse_ui_action_type
```
`from .checkout` (single dot) is wrong here — that resolves inside `tests/`.

## What's covered (one file per pure-logic module)
- `test_checkout.py` — canonical city resolution, `is_ready_for_order` gate, `merge_checkout`,
  `reduce_checkout` (the None-resets-checkout reducer), `build_create_order_payload`,
  `create_order` error-code → friendly-message mapping.
- `test_cart.py` — `find_complementary_suggestion` (cross-sell affinity) and
  `compute_suggested_next_step` (the deterministic next-step routing rule).
- `test_actions.py` — `[ui_action:...]` event parsing and the `UiAction` round-trip that
  `master_router` relies on to short-circuit button/form clicks.
- `test_personalization.py` — `summarize_user_context` / `describe_user_context`.

## Adding a new test
1. Name the file `test_<area>.py` and put it in this folder.
2. Import the code under test with `from ..<module> import ...`.
3. Use `unittest.TestCase`; keep it pure/deterministic (see Hard rules).
4. Add its module path to the suite run command above and confirm it passes from the master
   folder.
