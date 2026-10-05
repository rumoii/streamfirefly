import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { editionDefine } from './edition.mjs';
const define = editionDefine();
await build({ entryPoints: [fileURLToPath(new URL('../extension/src/background.js', import.meta.url))], bundle: true, format: 'iife', globalName: 'StreamFireflyBackground', target: 'es2022', outfile: fileURLToPath(new URL('../extension/dist/background.js', import.meta.url)), legalComments: 'none', define });
for (const name of ['offscreen', 'evaluation-worker']) await build({ entryPoints: [fileURLToPath(new URL(`../extension/src/${name}.${name === 'evaluation-worker' ? 'ts' : 'js'}`, import.meta.url))], bundle: true, format: 'iife', target: 'es2022', outfile: fileURLToPath(new URL(`../extension/dist/${name}.js`, import.meta.url)), legalComments: 'none', define });
