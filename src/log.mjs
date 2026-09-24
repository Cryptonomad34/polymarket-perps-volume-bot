// JSON-lines logger with level filtering, secret redaction and rotation
// (by size and by UTC day). Mirrors every line to the console in a short form.

import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY = /(^|_)(key|secret|sig|signature|private|privatekey|preimage)$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_FILES = 14;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function createLogger({ dir, level = "info", console: toConsole = true, name = "bot" } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let day = null;
  let file = null;
  let bytes = 0;

  function open() {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    day = utcDay();
    file = path.join(dir, `${name}-${day}.log`);
    bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }

  function rotateIfNeeded() {
    if (!dir) return;
    if (day !== utcDay()) open();
    if (bytes < MAX_BYTES) return;
    let n = 1;
    while (fs.existsSync(`${file}.${n}`)) n++;
    fs.renameSync(file, `${file}.${n}`);
    bytes = 0;
    prune();
  }

  function prune() {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${name}-`) && f.includes(".log"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_FILES)) fs.rmSync(path.join(dir, f), { force: true });
  }

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < min) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...redact(fields ?? {}) };
    const line = JSON.stringify(rec) + "\n";
    if (dir) {
      if (!file) open();
      rotateIfNeeded();
      fs.appendFileSync(file, line);
      bytes += Buffer.byteLength(line);
    }
    if (toConsole) {
      const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(redact(fields)) : "";
      const out = `${rec.ts.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`;
      (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(out + "\n");
    }
  }

  if (dir) {
    open();
    prune();
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
