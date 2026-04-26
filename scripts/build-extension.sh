#!/usr/bin/env bash
set -e

# Chrome — copy extension/ as-is
rm -rf dist-chrome && mkdir -p dist-chrome
cp -r extension/. dist-chrome/
echo "Chrome build ready: dist-chrome/"

# Firefox — merge manifests, strip unsupported APIs
rm -rf dist-firefox && mkdir -p dist-firefox
cp -r extension/. dist-firefox/
node -e "
const fs = require('fs');
const base = JSON.parse(fs.readFileSync('extension/manifest.json','utf8'));
const fx = JSON.parse(fs.readFileSync('extension/manifest.firefox.json','utf8'));
const merged = Object.assign({}, base, fx);
// Firefox MV3: no side_panel support
delete merged.side_panel;
// Firefox MV3: no offscreen permission
if (merged.permissions) merged.permissions = merged.permissions.filter(p => p !== 'offscreen');
fs.writeFileSync('dist-firefox/manifest.json', JSON.stringify(merged, null, 2));
console.log('Firefox manifest merged.');
"
echo "Firefox build ready: dist-firefox/"
