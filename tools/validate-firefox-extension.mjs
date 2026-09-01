import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repositoryRoot, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.firefox.json'), 'utf8'));
const required = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'tools', 'extension-package-files.json'), 'utf8'));
const missing = required.filter(file => !fs.existsSync(path.join(extensionRoot, file)));
const gecko = manifest.browser_specific_settings?.gecko;

if (manifest.manifest_version !== 3) throw new Error('Firefox manifest_version must be 3');
if (!Array.isArray(manifest.background?.scripts) || !manifest.background.scripts.includes('background.js')) throw new Error('Firefox background scripts missing');
if (manifest.background?.service_worker) throw new Error('Firefox manifest must not declare a service worker');
if (!manifest.permissions?.includes('nativeMessaging')) throw new Error('Firefox nativeMessaging permission missing');
if (!manifest.permissions?.includes('declarativeNetRequest')) throw new Error('Firefox declarativeNetRequest permission missing');
if (!manifest.permissions?.includes('webNavigation')) throw new Error('Firefox webNavigation permission missing');
if (gecko?.id !== 'streamfirefly@example.invalid') throw new Error(`Unexpected Firefox extension ID: ${gecko?.id}`);
if (Number.parseFloat(gecko?.strict_min_version) < 142) throw new Error('Firefox strict_min_version must be at least 142');
if (JSON.stringify(gecko?.data_collection_permissions?.required) !== JSON.stringify(['none'])) throw new Error('Firefox data collection declaration must be required: ["none"]');
if (manifest.version !== '0.8.0') throw new Error(`Unexpected Firefox extension version: ${manifest.version}`);
if (manifest.sidebar_action?.default_panel !== 'popup.html') throw new Error('Firefox sidebar entry missing');
if (missing.length) throw new Error(`Firefox package files missing: ${missing.join(', ')}`);
console.log(`StreamFirefly Firefox extension ${manifest.version} valid (${required.length} runtime files)`);
