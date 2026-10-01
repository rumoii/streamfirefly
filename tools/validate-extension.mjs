import { readBackgroundSource } from './read-background-source.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const background = readBackgroundSource();
const required = JSON.parse(fs.readFileSync(path.join(root, '..', 'tools', 'extension-package-files.json'), 'utf8'));
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
const appHtmlPath = path.join(root, 'dist', 'app.html');
const appScriptPath = path.join(root, 'dist', 'assets', 'app.js');
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (manifest.minimum_chrome_version !== '141') throw new Error('minimum_chrome_version must be 141 for sidePanel.close');
if (!manifest.background?.service_worker) throw new Error('background service worker missing');
if (!manifest.permissions?.includes('nativeMessaging')) throw new Error('nativeMessaging permission missing');
if (!manifest.permissions?.includes('declarativeNetRequest')) throw new Error('declarativeNetRequest permission missing');
if (!manifest.permissions?.includes('webNavigation')) throw new Error('webNavigation permission missing');
if (manifest.version !== '0.10.0') throw new Error(`unexpected extension version: ${manifest.version}`);
if (!manifest.permissions?.includes('sidePanel')) throw new Error('Chrome sidePanel permission missing');
if (manifest.side_panel?.default_path !== 'dist/app.html?surface=sidebar#/resources') throw new Error('Chrome side panel entry missing');
if (manifest.options_ui?.page !== 'dist/app.html?surface=options#/settings') throw new Error('Vue settings entry missing');
if (/\btabs\.create\s*\(/.test(readBackgroundSource(['background.js', 'workspace.js']))) throw new Error('Toolbar entry must not create an application tab');
if (/AppSession|app\.session\.|appTabId/.test(background)) throw new Error('Obsolete application session lifecycle is still present');
if (!background.includes('openPanelOnActionClick: false') || !background.includes('api.action?.onClicked?.addListener')) throw new Error('Toolbar floating panel entry is missing');
if (!background.includes('api.sidePanel.open({ windowId: tab.windowId })')) throw new Error('Native sidebar recovery entry is missing');
if (!background.includes('files: ["dist/workspace.js"]')) throw new Error('On-demand workspace injection is missing');
if (missing.length) throw new Error(`missing files: ${missing.join(', ')}`);
const appHtml = fs.readFileSync(appHtmlPath, 'utf8');
const appScript = fs.readFileSync(appScriptPath, 'utf8');
const hlsPreloaded = (appHtml.match(/<link\b[^>]*>/gi) || []).some(tag => /\brel=["']modulepreload["']/i.test(tag) && /\bhref=["'][^"']*hls\.js["']/i.test(tag));
if (hlsPreloaded) throw new Error('extension/dist/app.html must not preload assets/hls.js; keep build.modulePreload disabled');
const dynamicHlsImport = /\bimport\s*\(\s*["']\.\/hls\.js["']\s*\)/;
const appWithoutDynamicHlsImport = appScript.replace(dynamicHlsImport, '');
if (/\bfrom\s*["']\.\/hls\.js["']/.test(appWithoutDynamicHlsImport) || /\bimport\s*["']\.\/hls\.js["']/.test(appWithoutDynamicHlsImport)) {
  throw new Error('extension/dist/assets/app.js must not statically import ./hls.js; load HLS only when preview starts');
}
if (!dynamicHlsImport.test(appScript)) throw new Error('extension/dist/assets/app.js must dynamically import ./hls.js when HLS preview starts');
console.log(`StreamFirefly extension ${manifest.version} valid (${required.length} required files)`);
