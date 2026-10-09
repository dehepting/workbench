import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Zero-dependency .env loader. Loads from the package root and the current working
// directory. Existing real environment variables always win over file values.
export function loadEnv() {
  const roots = [
    dirname(dirname(fileURLToPath(import.meta.url))), // package root (next to bin/)
    process.cwd(),
  ];
  for (const root of roots) {
    for (const name of ['.env', '.env.local']) {
      const path = resolve(root, name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
    }
  }
}
