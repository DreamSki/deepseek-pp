#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.svg']);
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0
  ? requestedTargets
  : ['dist/chrome-mv3', 'dist/edge-mv3', 'dist/firefox-mv3'];
const failures = [];

for (const target of targets) {
  const targetPath = resolve(root, target);
  for (const filePath of walkFiles(targetPath)) {
    if (!textExtensions.has(extname(filePath))) continue;
    validateTextFile(filePath);
  }
}

if (failures.length > 0) {
  console.error('Extension encoding check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Extension encoding check passed');

function walkFiles(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) {
    failures.push(`missing build target: ${path}`);
    return [];
  }
  if (stat.isFile()) return [path];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    walkFiles(resolve(path, entry.name)),
  );
}

function validateTextFile(filePath) {
  const bytes = readFileSync(filePath);
  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    failures.push(`${filePath}: invalid UTF-8 (${error.message})`);
    return;
  }

  let offset = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (isUnicodeNoncharacter(codePoint)) {
      failures.push(
        `${filePath}: contains Unicode noncharacter U+${codePoint.toString(16).toUpperCase()} at character ${offset}`,
      );
    }
    offset += character.length;
  }
}

function isUnicodeNoncharacter(codePoint) {
  return (
    (codePoint >= 0xFDD0 && codePoint <= 0xFDEF) ||
    (codePoint & 0xFFFF) === 0xFFFE ||
    (codePoint & 0xFFFF) === 0xFFFF
  );
}
