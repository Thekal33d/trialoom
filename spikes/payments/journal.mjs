import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const json = (value) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2);
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Single-writer spike storage, NOT a concurrent ledger or production database.
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = openSync(temporary, 'w', 0o600);
  try { writeFileSync(file, json(value) + '\n'); fsyncSync(file); }
  finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
