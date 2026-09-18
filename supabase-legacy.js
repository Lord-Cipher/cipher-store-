'use strict';
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

function createLegacyStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'), { statusCode: 503, code: 'supabase_not_configured' });
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  function clean(path) { return String(path || '').replace(/^\/+|\/+$/g, ''); }
  function parts(path) { return clean(path).split('/').filter(Boolean); }
  function setNested(root, path, value) {
    const keys = parts(path); let cursor = root;
    keys.forEach((key, index) => { if (index === keys.length - 1) cursor[key] = value; else cursor = cursor[key] ||= {}; });
  }
  async function rows(prefix) {
    const p = clean(prefix);
    const query = client.from('legacy_data').select('path,value,version').limit(5000);
    const { data, error } = p ? await query.or(`path.eq.${p},path.like.${p}/%`) : await query;
    if (error) throw error;
    return data || [];
  }
  async function read(path) {
    const p = clean(path); const items = await rows(p); const exact = items.find(item => item.path === p);
    if (!items.length) return { exists: () => false, val: () => null };
    if (exact && items.length === 1) return { exists: () => exact.value !== null, val: () => exact.value };
    const root = exact?.value && typeof exact.value === 'object' ? structuredClone(exact.value) : {};
    for (const item of items) if (item.path !== p) setNested(root, item.path.slice(p ? p.length + 1 : 0), item.value);
    return { exists: () => Object.keys(root).length > 0 || Boolean(exact), val: () => root };
  }
  async function write(path, value) {
    const p = clean(path);
    const { error: removeError } = await client.from('legacy_data').delete().or(`path.eq.${p},path.like.${p}/%`);
    if (removeError) throw removeError;
    const { error } = await client.from('legacy_data').insert({ path: p, value, version: 1 });
    if (error) throw error;
  }
  function ref(path) {
    const p = clean(path);
    return {
      async once() { return read(p); },
      async set(value) { return write(p, value); },
      async update(patch) { const current = (await read(p)).val() || {}; return write(p, { ...current, ...patch }); },
      async remove() { return write(p, null); },
      push() { const key = crypto.randomBytes(8).toString('hex'); return { key, set: value => write(`${p}/${key}`, value) }; },
      async transaction(callback) { const current = (await read(p)).val(); const next = callback(current); if (typeof next === 'undefined') return { committed: false, snapshot: { val: () => current } }; await write(p, next); return { committed: true, snapshot: { val: () => next } }; },
      limitToLast() { return this; }
    };
  }
  return { ref, client };
}
module.exports = { createLegacyStore };
