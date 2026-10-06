import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../extension/vendor/', import.meta.url), { recursive: true });
await copyFile(new URL('../node_modules/js-yaml/dist/js-yaml.mjs', import.meta.url), new URL('../extension/vendor/js-yaml.mjs', import.meta.url));
await copyFile(new URL('../node_modules/js-yaml/LICENSE', import.meta.url), new URL('../extension/vendor/js-yaml.LICENSE', import.meta.url));
console.log('Vendored local js-yaml; no remote executable code.');
