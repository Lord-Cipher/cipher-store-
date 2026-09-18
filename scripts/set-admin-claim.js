#!/usr/bin/env node
'use strict';
const { createClient } = require('@supabase/supabase-js');
const email = String(process.argv[2] || '').trim().toLowerCase();
const role = String(process.argv[3] || 'owner').trim();
if (!email) { console.error('Usage: npm run set-admin -- admin@example.com [owner|admin|manager]'); process.exit(1); }
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Run only on a trusted machine.'); process.exit(1); }
(async () => {
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const user = (data.users || []).find(candidate => candidate.email?.toLowerCase() === email);
  if (!user) throw new Error(`No Supabase Auth user found for ${email}`);
  const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, { app_metadata: { ...(user.app_metadata || {}), admin: true, role } });
  if (updateError) throw updateError;
  console.log(`Supabase admin role '${role}' set for ${email} (${user.id}). Sign out and sign back in to refresh the session.`);
})().catch(error => { console.error(error.message); process.exit(1); });
