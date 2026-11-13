import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cdpUp(cdp, timeoutMs = 1500) {
  try {
    const res = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid(file) {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function spawnDaemon({ root, cdp, command }) {
  const [cmd, ...args] = command ?? [process.execPath, path.join(root, 'src', 'sessiond.mjs')];
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const out = fs.openSync(path.join(root, 'logs', 'sessiond.log'), 'a');
  const child = spawn(cmd, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, SESSIOND_PORT: new URL(cdp).port },
  });
  fs.closeSync(out);
  child.unref();
  return child;
}

// Makes sure something answers CDP at `cdp`, starting sessiond detached if nothing does.
// A pid file keeps concurrent MCP servers from each spawning their own daemon.
export async function ensureDaemon({ root, cdp, command, startupMs = 30000, pollMs = 500, log = () => {} }) {
  if (await cdpUp(cdp)) return { started: false };

  const pidFile = path.join(root, '.private', 'sessiond.pid');
  const known = readPid(pidFile);
  let failure = null;
  if (!known || !pidAlive(known)) {
    const child = spawnDaemon({ root, cdp, command });
    child.once('error', (e) => { failure = e; });
    child.once('exit', (code, signal) => { failure = new Error(`exited (${signal ?? `code ${code}`})`); });
    if (child.pid) {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(child.pid));
    }
    log(`sessiond not reachable at ${cdp} — spawned pid ${child.pid}`);
  } else {
    log(`sessiond pid ${known} already starting — waiting for ${cdp}`);
  }

  const deadline = Date.now() + startupMs;
  while (Date.now() < deadline) {
    if (await cdpUp(cdp)) return { started: true };
    if (failure) throw new Error(`sessiond failed to start: ${failure.message} — see logs/sessiond.log`);
    await sleep(pollMs);
  }
  throw new Error(`sessiond did not open CDP at ${cdp} within ${startupMs / 1000}s — see logs/sessiond.log`);
}
