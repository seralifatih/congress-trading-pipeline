"""Tests for the LDA global rate limiter.

The production failure this guards against: 254 page tasks sharing one
per-key quota, burning it in a burst, then 429-storming each other to
death. The limiter must (a) space request starts, (b) make a 429
cooldown apply to every task, not just the one that got the 429.
"""

from __future__ import annotations

import asyncio
import time

from src.sources.lda import RATE_ANONYMOUS, RATE_WITH_KEY, _RateLimiter


def run(coro):  # small helper — pytest-asyncio not in deps
    return asyncio.new_event_loop().run_until_complete(coro)


class TestRateLimiter:
    def test_spaces_requests(self) -> None:
        async def scenario() -> float:
            limiter = _RateLimiter(rate_per_sec=50)  # 20ms interval
            start = time.perf_counter()
            for _ in range(5):
                await limiter.acquire()
            return time.perf_counter() - start

        elapsed = run(scenario())
        # 5 acquires at 20ms spacing -> at least ~80ms total.
        assert elapsed >= 0.07

    def test_first_acquire_immediate(self) -> None:
        async def scenario() -> float:
            limiter = _RateLimiter(rate_per_sec=1)
            start = time.perf_counter()
            await limiter.acquire()
            return time.perf_counter() - start

        assert run(scenario()) < 0.05

    def test_cooldown_delays_everyone(self) -> None:
        async def scenario() -> float:
            limiter = _RateLimiter(rate_per_sec=1000)
            await limiter.acquire()
            limiter.cooldown(0.15)
            start = time.perf_counter()
            # A DIFFERENT logical task acquiring must also wait out the
            # cooldown — that is the whole point of it being shared.
            await limiter.acquire()
            return time.perf_counter() - start

        assert run(scenario()) >= 0.12

    def test_cooldown_never_shortens(self) -> None:
        async def scenario() -> float:
            limiter = _RateLimiter(rate_per_sec=1000)
            limiter.cooldown(0.15)
            limiter.cooldown(0.01)  # shorter cooldown must not undo longer
            start = time.perf_counter()
            await limiter.acquire()
            return time.perf_counter() - start

        assert run(scenario()) >= 0.12

    def test_concurrent_acquires_serialized(self) -> None:
        async def scenario() -> float:
            limiter = _RateLimiter(rate_per_sec=50)  # 20ms interval
            start = time.perf_counter()
            await asyncio.gather(*(limiter.acquire() for _ in range(5)))
            return time.perf_counter() - start

        # Even fired concurrently, 5 starts must span >= ~4 intervals.
        assert run(scenario()) >= 0.07


def test_configured_rates_under_documented_limits() -> None:
    assert RATE_WITH_KEY * 60 <= 120  # registered quota ~120/min
    assert RATE_ANONYMOUS * 60 <= 15  # anonymous quota ~15/min
