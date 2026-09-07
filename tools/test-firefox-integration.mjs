import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('extension/manifest.firefox.json'));
const extensionId = manifest.browser_specific_settings?.gecko?.id;
if (extensionId !== 'streamfirefly@example.invalid') throw new Error(`Unexpected Firefox extension ID: ${extensionId}`);
if (manifest.sidebar_action?.default_panel !== 'dist/app.html?surface=sidebar#/resources') throw new Error('Firefox sidebar panel entry is missing');

const background = read('extension/background.js');
if (!background.includes('api.storage.local.get(Object.keys(DEFAULT_SETTINGS))')) throw new Error('Firefox-safe settings key-array load is missing');
if (/\btabs\.create\s*\(/.test(background)) throw new Error('Toolbar entry still creates an application tab');
if (!background.includes('api.sidebarAction.open()')) throw new Error('Firefox toolbar action does not open the sidebar');
if (!background.includes('type === "ui.context.get"') || !background.includes('type === "workspace.open"')) throw new Error('Sidebar context or workspace message contract is missing');

const register = read('tools/register-native-host.ps1');
if (!register.includes("allowed_extensions = @($FirefoxExtensionId)")) throw new Error('Firefox native manifest does not use allowed_extensions');
if (!register.includes('Software\\Mozilla\\NativeMessagingHosts\\com.streamfirefly.native')) throw new Error('Firefox native host registry path is missing');

const installer = read('installer/StreamFirefly.iss');
if (!installer.includes('#define FirefoxExtensionId "streamfirefly@example.invalid"')) throw new Error('Installer Firefox extension ID is missing');
if (!installer.includes('-FirefoxExtensionId ""{#FirefoxExtensionId}""')) throw new Error('Installer does not pass the Firefox extension ID to registration');
if (!installer.includes('Software\\Mozilla\\NativeMessagingHosts\\com.streamfirefly.native')) throw new Error('Installer does not remove the Firefox native host registry key');

const build = read('tools/build-installer.ps1');
const release = read('tools/prepare-release.ps1');
if (!build.includes("[string]$FirefoxExtensionId = 'streamfirefly@example.invalid'")) throw new Error('Installer builder has no Firefox ID input');
if (!release.includes('-FirefoxExtensionId $FirefoxExtensionId')) throw new Error('Release builder does not forward the Firefox ID');

const uninstall = read('tools/uninstall-internal-test.ps1');
if (!uninstall.includes('Software\\Mozilla\\NativeMessagingHosts\\com.streamfirefly.native') || !uninstall.includes('com.streamfirefly.native.firefox.json')) throw new Error('Internal uninstaller does not remove Firefox native host files');
const packageFirefox = read('tools/package-firefox-extension.ps1');
if (!packageFirefox.includes("@('dist/assets/app.js', 'dist/workspace.js') -contains $_.file")) throw new Error('Firefox lint does not narrowly scope Vue runtime warnings to both bundles');
if (!packageFirefox.includes("'v-html|\\.innerHTML\\s*='")) throw new Error('Firefox lint warning exception has no source-level innerHTML rejection');
const browserTest = read('tools/test-browser-extension.mjs');
if (!browserTest.includes('waitFor = async (operation, label, timeoutMs = 30000)') || !browserTest.includes(')), 60000)')) throw new Error('Browser tests do not use independent step and process deadlines');
if (!browserTest.includes('await unmountWorkspace(tab.id)')) throw new Error('Browser tests do not exercise the production workspace disposal path');
console.log('Firefox manifest, packaging, native registration, and uninstall contracts passed');
