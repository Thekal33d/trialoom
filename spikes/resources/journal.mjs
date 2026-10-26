import { existsSync } from 'node:fs';
import { atomic } from './quotes.mjs';
import { readJson, writePrivateJson } from '../payments/journal.mjs';

const states = ['reserved', 'needs_reconciliation', 'settled', 'not_spent'];
const remaining = (data) => atomic(data.ceilingUnits) - data.entries.reduce((sum, entry) =>
  sum + (entry.state === 'not_spent' ? 0n : atomic(entry.amountUnits)), 0n);

// Explicit creation: a missing/corrupt existing file is never an empty budget.
export function createResourceJournal(path, ceilingUnits) {
  atomic(ceilingUnits);
  if (existsSync(path)) throw new Error('Journal already exists');
  writePrivateJson(path, { version: 1, ceilingUnits, entries: [] });
  return resourceJournal(path);
}
export function resourceJournal(path) {
  function load() {
    const data = readJson(path);
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid journal');
    atomic(data.ceilingUnits);
    const ids = new Set();
    for (const entry of data.entries) {
      if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !states.includes(entry.state)) throw new Error('Invalid purchase journal');
      atomic(entry.amountUnits);
      ids.add(entry.id);
    }
    if (remaining(data) < 0n) throw new Error('Journal budget exceeded');
    return data;
  }
  const modify = (id, action) => {
    const data = load();
    const entry = data.entries.find((item) => item.id === id);
    if (!entry) throw new Error('Unknown purchase');
    action(entry);
    writePrivateJson(path, data);
  };
  return {
    get: (id) => load().entries.find((entry) => entry.id === id),
    summary: () => {
      const data = load();
      return { ceilingUnits: data.ceilingUnits, availableUnits: String(remaining(data)),
        committedUnits: String(data.entries.filter((entry) => ['reserved', 'needs_reconciliation'].includes(entry.state))
          .reduce((sum, entry) => sum + atomic(entry.amountUnits), 0n)),
        spentUnits: String(data.entries.filter((entry) => entry.state === 'settled')
          .reduce((sum, entry) => sum + atomic(entry.amountUnits), 0n)),
        // No output has been validated in this experiment, so no builder charge is authorized.
        builderChargeUnits: '0' };
    },
    reserve: (id, terms) => {
      const data = load();
      if (!id || typeof id !== 'string' || data.entries.some((entry) => entry.id === id)) throw new Error('Purchase already exists; reconcile it');
      if (atomic(terms.amountUnits) > remaining(data)) throw new Error('Resource budget exhausted');
      data.entries.push({ ...terms, id, state: 'reserved' });
      writePrivateJson(path, data);
    },
    authorize: (id, authorization) => modify(id, (entry) => {
      if (entry.state !== 'reserved' || entry.authorization) throw new Error('Authorization already recorded');
      if (authorization.value !== entry.amountUnits || authorization.from?.toLowerCase() !== entry.payer.toLowerCase() ||
        authorization.to?.toLowerCase() !== entry.payTo.toLowerCase() || !/^0x[\da-f]{64}$/i.test(authorization.nonce) ||
        !/^\d+$/.test(authorization.validAfter) || !/^\d+$/.test(authorization.validBefore)) throw new Error('Authorization terms mismatch');
      const { from, to, value, nonce, validAfter, validBefore } = authorization;
      entry.authorization = { from, to, value, nonce, validAfter, validBefore }; // Never store signature/header.
      entry.state = 'needs_reconciliation';
    }),
    observe: (id, { status, poll }) => modify(id, (entry) => {
      entry.response = { status, ...(poll ? { poll } : {}) };
      // HTTP status, including 2xx/4xx/402, cannot prove payment finality or release the commitment.
    }),
    reconcile: (id, result) => modify(id, (entry) => {
      // Internal result from the chain reconciler; never accept client-supplied state updates.
      if (!entry.authorization || !['settled', 'not_spent', 'needs_reconciliation'].includes(result.state)) throw new Error('Invalid reconciliation');
      entry.state = result.state;
      entry.chainEvidence = result;
    }),
  };
}
