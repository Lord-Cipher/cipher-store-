#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.join(process.cwd(), '.env.local'));
loadEnv(path.join(process.cwd(), '.env'));

const email = process.argv[2];
const role = process.argv[3] || 'owner';
if (!email) {
  console.error('Usage: node scripts/set-admin-claim.js admin@example.com');
  process.exit(1);
}

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON is required. Run this utility only on a trusted machine.');
  process.exit(1);
}

(async () => {
  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  const user = await admin.auth().getUserByEmail(email);
  const existing = user.customClaims || {};
  await admin.auth().setCustomUserClaims(user.uid, { ...existing, admin: true, role });
  console.log(`Admin claim set for ${user.email} (${user.uid}) with role ${role}. Sign out and sign back in to refresh the ID token.`);
})().catch(error => {
  console.error(error.code || error.message);
  process.exit(1);
});
