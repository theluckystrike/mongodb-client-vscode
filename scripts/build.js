'use strict';
// Bundles with esbuild: dist/extension.js (activation code, no driver), dist/mongo.js (the MongoDB driver and
// everything that talks to the server, loaded on the first connect) and dist/webview.js.
// The driver's optional native add-ons (kerberos, snappy, zstd, client-side encryption) and cloud credential
// helpers are left out: the driver loads them only when a connection string asks for them, and says so.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
const OPTIONAL = ['kerberos', 'snappy', '@mongodb-js/zstd', 'mongodb-client-encryption', '@aws-sdk/credential-providers', 'gcp-metadata', 'socks', 'aws4', '@mongodb-js/saslprep-native'];
const lazyDriver = {
  name: 'lazy-driver',
  setup(b) { b.onResolve({ filter: /^\.\/core\/mongo$/ }, () => ({ path: './mongo.js', external: true })); },
};
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], plugins: [lazyDriver] }),
  esbuild.build({ ...common, entryPoints: ['src/core/mongo.js'], outfile: 'dist/mongo.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode', ...OPTIONAL] }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).then(() => {
  const ext = fs.readFileSync(path.join(root, 'dist/extension.js'), 'utf8');
  if (/MongoClient|require\("mongodb"\)/.test(ext)) { console.error('dist/extension.js must not contain the driver'); process.exit(1); }
}).catch(() => process.exit(1));
