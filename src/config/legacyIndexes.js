// Older databases keep indexes built by earlier schema versions. Mongoose's autoIndex skips an
// index whose name already exists, so a changed definition never reaches those databases. Each
// entry here rebuilds one such index to match the current schema; already-correct ones are left alone.
const LEGACY_INDEXES = [
  {
    // Was unique on {user, purpose} for every credential, which blocked a user who already had a
    // personal key from connecting an institution key for the same purpose (see AiCredential.js).
    collection: 'aicredentials',
    name: 'user_1_purpose_1',
    key: { user: 1, purpose: 1 },
    options: { unique: true, partialFilterExpression: { scope: 'user' } },
    isLegacy: (index) => !index.partialFilterExpression
  },
  {
    // Was unique on every commission's application; a guest hire's commission has none, so the
    // index now covers only commissions that do (see Commission.js).
    collection: 'commissions',
    name: 'application_1',
    key: { application: 1 },
    options: { unique: true, partialFilterExpression: { application: { $type: 'objectId' } } },
    isLegacy: (index) => !index.partialFilterExpression
  }
];

async function repairLegacyIndexes(db) {
  for (const fix of LEGACY_INDEXES) {
    const collection = db.collection(fix.collection);
    const existing = (await collection.indexes().catch(() => [])).find((index) => index.name === fix.name);
    if (!existing || !fix.isLegacy(existing)) continue;
    await collection.dropIndex(fix.name);
    await collection.createIndex(fix.key, { name: fix.name, ...fix.options });
    console.log(`[DB] Rebuilt legacy index ${fix.collection}.${fix.name}`);
  }
}

module.exports = { repairLegacyIndexes, LEGACY_INDEXES };
