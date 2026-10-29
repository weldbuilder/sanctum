#!/usr/bin/env python3
"""TCP relay 0.0.0.0:9223 -> 127.0.0.1:9222.

Chromium binds its DevTools port to loopback only (it ignores --remote-debugging-address),
so Docker's port publish cannot reach it directly. This forwards the published port to it.
Only 9223 is published, and only on the host's 127.0.0.1 (see docker-compose.yml)."""
import asyncio

async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d); await w.drain()
    except Exception:
        pass
    finally:
        w.close()

async def handle(cr, cw):
    try:
        ur, uw = await asyncio.open_connection("127.0.0.1", 9222)
    except Exception:
        cw.close(); return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))

async def main():
    s = await asyncio.start_server(handle, "0.0.0.0", 9223)
    async with s:
        await s.serve_forever()

asyncio.run(main())
