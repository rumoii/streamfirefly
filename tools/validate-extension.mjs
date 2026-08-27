import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const required = ['background.js', 'content.js', 'page-probe.js', 'popup.html', 'popup.js', 'popup.css', 'options.html', 'options.js', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (!manifest.background?.service_worker) throw new Error('background service worker missing');
if (!manifest.permissions?.includes('nativeMessaging')) throw new Error('nativeMessaging permission missing');
if (missing.length) throw new Error(`missing files: ${missing.join(', ')}`);
console.log(`StreamFirefly extension ${manifest.version} valid (${required.length} required files)`);
