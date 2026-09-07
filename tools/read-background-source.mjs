import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../extension/src/', import.meta.url));
export function readBackgroundSource(files) { return (files || fs.readdirSync(root).filter(name => name.endsWith('.js'))).sort().map(name => fs.readFileSync(root + '/' + name, 'utf8')).join('\n'); }
