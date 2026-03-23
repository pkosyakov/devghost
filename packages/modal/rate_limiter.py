"""Simple token-bucket rate limiter for OpenRouter API calls."""
import time
import threading


class RateLimiter:
    def __init__(self, max_qps: float = 5.0):
        self.interval = 1.0 / max_qps
        self.last_call = 0.0
        self.lock = threading.Lock()

    def wait(self):
        """Block until rate limit allows next call."""
        with self.lock:
            now = time.monotonic()
            wait_time = self.interval - (now - self.last_call)
            if wait_time > 0:
                time.sleep(wait_time)
            self.last_call = time.monotonic()
