import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const required = JSON.parse(fs.readFileSync(path.join(root, '..', 'tools', 'extension-package-files.json'), 'utf8'));
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (!manifest.background?.service_worker) throw new Error('background service worker missing');
if (!manifest.permissions?.includes('nativeMessaging')) throw new Error('nativeMessaging permission missing');
if (!manifest.permissions?.includes('declarativeNetRequest')) throw new Error('declarativeNetRequest permission missing');
if (!manifest.permissions?.includes('webNavigation')) throw new Error('webNavigation permission missing');
if (manifest.version !== '0.9.0') throw new Error(`unexpected extension version: ${manifest.version}`);
if (manifest.permissions?.includes('sidePanel') || manifest.side_panel) throw new Error('Obsolete Chrome side panel entry is still present');
if (manifest.options_ui?.page !== 'dist/app.html#/settings') throw new Error('Vue settings entry missing');
if (missing.length) throw new Error(`missing files: ${missing.join(', ')}`);
console.log(`StreamFirefly extension ${manifest.version} valid (${required.length} required files)`);
