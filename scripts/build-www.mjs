// Copies the static PWA into www/ so Capacitor can bundle it into the iOS app.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const OUT = 'www';
const ENTRIES = ['index.html', 'manifest.json', 'icon.svg', 'sw.js', 'src', 'data'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const e of ENTRIES) cpSync(e, `${OUT}/${e}`, { recursive: true });
console.log(`Copied ${ENTRIES.length} entries to ${OUT}/`);
