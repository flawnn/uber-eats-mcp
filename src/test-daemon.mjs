import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { cdpUp, ensureDaemon } from './lib/daemon.mjs';

const FAKE_DAEMON = `
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
fs.appendFileSync(path.join(process.cwd(), 'spawned.marker'), 'x');
http.createServer((req, res) => res.end('{}')).listen(Number(process.env.SESSIOND_PORT), '127.0.0.1');
`;

let root;
let scriptPath;

const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const spawnedCount = () => {
  try { return fs.readFileSync(path.join(root, 'spawned.marker'), 'utf8').length; } catch { return 0; }
};

const killPidFile = () => {
  try { process.kill(parseInt(fs.readFileSync(path.join(root, '.private', 'sessiond.pid'), 'utf8'), 10)); } catch { /* already gone */ }
  fs.rmSync(path.join(root, '.private'), { recursive: true, force: true });
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-daemon-'));
  scriptPath = path.join(root, 'fake-daemon.mjs');
  fs.writeFileSync(scriptPath, FAKE_DAEMON);
});

after(() => {
  killPidFile();
  fs.rmSync(root, { recursive: true, force: true });
});

test('cdpUp reflects whether anything answers', async () => {
  const port = await freePort();
  assert.equal(await cdpUp(`http://127.0.0.1:${port}`, 300), false);
  const server = http.createServer((q, r) => r.end('{}')).listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  assert.equal(await cdpUp(`http://127.0.0.1:${port}`, 300), true);
  server.close();
});

test('ensureDaemon spawns a detached daemon when CDP is down, then reuses it', async () => {
  const cdp = `http://127.0.0.1:${await freePort()}`;
  const command = [process.execPath, scriptPath];

  assert.deepEqual(await ensureDaemon({ root, cdp, command, startupMs: 10000, pollMs: 50 }), { started: true });
  assert.equal(spawnedCount(), 1);
  assert.equal(await cdpUp(cdp), true);
  assert.ok(fs.existsSync(path.join(root, '.private', 'sessiond.pid')));

  assert.deepEqual(await ensureDaemon({ root, cdp, command }), { started: false });
  assert.equal(spawnedCount(), 1);
  killPidFile();
});

test('ensureDaemon does not double-spawn while a recorded daemon is still alive', async () => {
  const before = spawnedCount();
  fs.mkdirSync(path.join(root, '.private'), { recursive: true });
  fs.writeFileSync(path.join(root, '.private', 'sessiond.pid'), String(process.pid));
  const cdp = `http://127.0.0.1:${await freePort()}`;

  await assert.rejects(
    ensureDaemon({ root, cdp, command: [process.execPath, scriptPath], startupMs: 300, pollMs: 50 }),
    /did not open CDP/,
  );
  assert.equal(spawnedCount(), before);
  fs.rmSync(path.join(root, '.private'), { recursive: true, force: true });
});

test('ensureDaemon fails fast when the daemon exits during startup', async () => {
  const cdp = `http://127.0.0.1:${await freePort()}`;
  const started = Date.now();
  await assert.rejects(
    ensureDaemon({ root, cdp, command: [process.execPath, '-e', 'process.exit(3)'], startupMs: 20000, pollMs: 50 }),
    /failed to start: exited \(code 3\)/,
  );
  assert.ok(Date.now() - started < 10000);
  fs.rmSync(path.join(root, '.private'), { recursive: true, force: true });
});
