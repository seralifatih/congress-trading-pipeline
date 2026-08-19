"""Allow `python -m src` to run the actor (Apify's standard entry point)."""

import asyncio

from .main import main

asyncio.run(main())
