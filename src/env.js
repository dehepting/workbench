import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Zero-dependency .env parser.
//
// Handles the shape .env.example hands out — `KEY=   # what it's for` — which
// used to be taken literally, turning every commented-out line into a
// non-empty fake API key (the dashboard happily reported 15/15 providers
// configured) and appending the trailing comment to real keys (401s).
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      // Quoted: the quote delimits, so `#` inside stays literal.
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      // Unquoted: `#` starts a comment when it opens the value or follows
      // whitespace — so `KEY=   # what it's for` empties out to '' instead of
      // becoming a fake key, while a `#` glued to a token stays part of it.
      const hash = value.search(/(^|\s)#/);
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

// Loads from the package root and the current working directory.
// Existing real environment variables always win over file values.
export function loadEnv() {
  const roots = [
    dirname(dirname(fileURLToPath(import.meta.url))), // package root (next to bin/)
    process.cwd(),
  ];
  for (const root of roots) {
    for (const name of ['.env', '.env.local']) {
      const path = resolve(root, name);
      if (!existsSync(path)) continue;
      for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
        if (!(key in process.env)) process.env[key] = value;
      }
    }
  }
}
