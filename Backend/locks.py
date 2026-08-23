"""Per-thread locks guarding the read-modify-write-resume sequence used by /chat and the
UI-action endpoints, so a button click and an in-flight chat call for the same thread
can't interleave checkpoint writes. In-memory — fine for a single-instance deployment.
"""

import asyncio
from collections import defaultdict

_thread_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_thread_lock(thread_id: str) -> asyncio.Lock:
    return _thread_locks[thread_id]
