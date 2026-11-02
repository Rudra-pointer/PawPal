const windows = new Map();
let lastSweep = 0;

export function rateLimit({ windowMs = 15 * 60_000, max = 300, code = 'RATE_LIMITED', message = 'Too many requests. Please try again later.', keyPrefix = 'global' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [key, value] of windows) if (value.resetAt <= now) windows.delete(key);
      lastSweep = now;
    }
    const key = `${keyPrefix}:${req.ip}`;
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: { code, message, details: [] } });
    }
    next();
  };
}
