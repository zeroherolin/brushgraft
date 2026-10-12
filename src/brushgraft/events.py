"""Push job progress from worker threads to the browser (Server-Sent Events)."""

import asyncio
import threading


class EventBus:
    """Thread-safe broadcast: workers publish, event-loop subscribers read."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = threading.Lock()
        self._closed = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        """Subscribe to events. A None in the queue means the server is closing."""
        queue: asyncio.Queue = asyncio.Queue()
        with self._lock:
            if self._closed:
                queue.put_nowait(None)
            self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.discard(queue)

    def publish(self, event: dict | None) -> None:
        """Callable from any thread; dropped when no loop is bound (as in tests)."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            queues = list(self._subscribers)
        for queue in queues:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:  # the loop has closed
                return

    def close(self) -> None:
        """Tell every subscriber to finish; open streams would stall shutdown."""
        with self._lock:
            self._closed = True
        self.publish(None)
