import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Simple file cache with TTL, keyed by an arbitrary string.
export class FileCache {
  constructor(dir, defaultTtlMs = 5 * 60 * 1000) {
    this.dir = dir;
    this.defaultTtlMs = defaultTtlMs;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(key) {
    return path.join(this.dir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  }

  get(key) {
    const f = this.fileFor(key);
    if (!fs.existsSync(f)) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Date.now() - rec.ts > (rec.ttlMs ?? this.defaultTtlMs)) return null;
      return rec.value;
    } catch {
      return null;
    }
  }

  set(key, value, ttlMs) {
    fs.writeFileSync(this.fileFor(key), JSON.stringify({ ts: Date.now(), ttlMs: ttlMs ?? this.defaultTtlMs, value }));
  }

  has(key) { return this.get(key) !== null; }
}
