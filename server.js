const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

loadEnvFile(path.join(__dirname, '.env.local'));
loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://cipher-pro-store-default-rtdb.firebaseio.com';
const OXAPAY_API_BASE = 'https://api.oxapay.com/v1';
const OXAPAY_SANDBOX = String(process.env.OXAPAY_SANDBOX || 'false').toLowerCase() === 'true';
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const GAME_ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();
let database;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function getDatabase() {
  if (database) return database;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw Object.assign(new Error('Firebase Admin credentials are not configured on this server'), { statusCode: 503, code: 'firebase_not_configured' });
  }
  if (!admin.apps.length) {
    const options = { databaseURL: DATABASE_URL };
    if (serviceAccountJson) {
      options.credential = admin.credential.cert(JSON.parse(serviceAccountJson));
    } else {
      options.credential = admin.credential.applicationDefault();
    }
    admin.initializeApp(options);
  }
  database = admin.database();
  return database;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function safeString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function enforceRateLimit(req, bucket, limit) {
  const now = Date.now();
  const address = safeString(req.socket?.remoteAddress || 'unknown', 120);
  const key = `${bucket}:${address}`;
  const current = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    current.startedAt = now;
    current.count = 0;
  }
  current.count += 1;
  rateBuckets.set(key, current);
  if (current.count > limit) throw Object.assign(new Error('Too many requests. Please wait a moment and try again.'), { statusCode: 429, code: 'rate_limited' });
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

async function requireUser(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  getDatabase();
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch {
    throw Object.assign(new Error('Invalid or expired authentication token'), { statusCode: 401 });
  }
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.admin !== true) {
    throw Object.assign(new Error('Administrator access required'), { statusCode: 403, code: 'admin_required' });
  }
  return user;
}

async function writeAudit(user, action, details = {}) {
  await getDatabase().ref('auditLogs').push({
    actorId: user.uid,
    actorEmail: safeString(user.email, 320),
    action: safeString(action, 120),
    details,
    createdAt: new Date().toISOString()
  });
}

function getProductsRef() {
  return getDatabase().ref('products');
}

async function getProductMap() {
  const snapshot = await getProductsRef().once('value');
  return snapshot.exists() ? snapshot.val() : {};
}

function getProductPrice(product) {
  const value = Number(product?.discountedPrice);
  return Number.isFinite(value) && value >= 0 ? roundMoney(value) : NaN;
}

function getCouponDiscount(coupon, subtotal) {
  if (!coupon || !coupon.isActive) return null;
  if (coupon.startDate && new Date(coupon.startDate).getTime() > Date.now()) return null;
  if (coupon.expiryDate && new Date(coupon.expiryDate).getTime() <= Date.now()) return null;
  const usageLimit = Number(coupon.usageLimit || 0);
  const usedCount = Number(coupon.usedCount || 0);
  const reservedCount = Number(coupon.reservedCount || 0);
  if (usageLimit > 0 && usedCount + reservedCount >= usageLimit) return null;
  const minimum = Number(coupon.minAmount || 0);
  if (subtotal < minimum) return null;
  let discount = coupon.discountType === 'percentage'
    ? subtotal * Number(coupon.discountValue || 0) / 100
    : Number(coupon.discountValue || 0);
  if (coupon.discountType === 'percentage' && Number(coupon.maxDiscount || 0) > 0) {
    discount = Math.min(discount, Number(coupon.maxDiscount));
  }
  discount = Math.max(0, Math.min(roundMoney(discount), subtotal));
  return {
    id: coupon.id,
    code: safeString(coupon.code, 40),
    discountType: coupon.discountType,
    discountValue: Number(coupon.discountValue || 0),
    minAmount: minimum,
    maxDiscount: Number(coupon.maxDiscount || 0),
    discountAmount: discount,
    autoDelete: coupon.autoDelete !== false
  };
}

async function findCoupon(code) {
  const normalized = safeString(code, 40).toUpperCase();
  if (!normalized) return null;
  const snapshot = await getDatabase().ref('coupons').once('value');
  if (!snapshot.exists()) return null;
  const coupons = snapshot.val();
  for (const [id, coupon] of Object.entries(coupons)) {
    if (safeString(coupon.code, 40).toUpperCase() === normalized) return { id, ...coupon };
  }
  return null;
}

async function reserveCouponForSession(couponId, sessionId, session) {
  const couponRef = getDatabase().ref(`coupons/${couponId}`);
  return couponRef.transaction(current => {
    if (!current || !current.isActive) return;
    if (current.startDate && new Date(current.startDate).getTime() > Date.now()) return;
    if (current.expiryDate && new Date(current.expiryDate).getTime() <= Date.now()) return;
    const usageLimit = Number(current.usageLimit || 0);
    const usedCount = Number(current.usedCount || 0);
    const reservedCount = Number(current.reservedCount || 0);
    const reservations = current.reservations || {};
    if (reservations[sessionId]) return current;
    if (usageLimit > 0 && usedCount + reservedCount >= usageLimit) return;
    return {
      ...current,
      reservedCount: reservedCount + 1,
      reservations: {
        ...reservations,
        [sessionId]: {
          userId: session.userId,
          total: session.total,
          reservedAt: new Date().toISOString()
        }
      }
    };
  });
}

async function releaseCouponReservation(couponId, sessionId) {
  const couponRef = getDatabase().ref(`coupons/${couponId}`);
  await couponRef.transaction(current => {
    if (!current) return current;
    const reservations = { ...(current.reservations || {}) };
    if (!reservations[sessionId]) return current;
    delete reservations[sessionId];
    return {
      ...current,
      reservedCount: Math.max(0, Number(current.reservedCount || 0) - 1),
      reservations
    };
  });
}

async function cleanupExpiredCoupons() {
  const snapshot = await getDatabase().ref('coupons').once('value');
  if (!snapshot.exists()) return 0;
  const now = Date.now();
  const updates = {};
  let deletedCount = 0;
  for (const [id, coupon] of Object.entries(snapshot.val())) {
    const reservations = { ...(coupon.reservations || {}) };
    let changed = false;
    for (const [sessionId, reservation] of Object.entries(reservations)) {
      const reservedAt = new Date(reservation.reservedAt || 0).getTime();
      if (!reservedAt || now - reservedAt > SESSION_TTL_MS + 15 * 60 * 1000) {
        delete reservations[sessionId];
        changed = true;
      }
    }
    const reservedCount = Object.keys(reservations).length;
    const expired = coupon.expiryDate && new Date(coupon.expiryDate).getTime() <= now;
    const limitReached = Number(coupon.usageLimit || 0) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit);
    if (coupon.autoDelete !== false && (expired || limitReached) && reservedCount === 0) {
      updates[`coupons/${id}`] = null;
      deletedCount++;
    } else if (changed || Number(coupon.reservedCount || 0) !== reservedCount) {
      updates[`coupons/${id}/reservations`] = reservations;
      updates[`coupons/${id}/reservedCount`] = reservedCount;
    }
  }
  if (Object.keys(updates).length) await getDatabase().ref().update(updates);
  return deletedCount;
}

async function scanPriceAlerts() {
  const db = getDatabase();
  const [alertsSnapshot, productsSnapshot] = await Promise.all([
    db.ref('priceAlerts').once('value'),
    db.ref('products').once('value')
  ]);
  if (!alertsSnapshot.exists() || !productsSnapshot.exists()) return 0;
  const products = productsSnapshot.val();
  const updates = {};
  let triggered = 0;
  for (const [userId, userAlerts] of Object.entries(alertsSnapshot.val())) {
    for (const [productId, alert] of Object.entries(userAlerts || {})) {
      if (!alert?.active) continue;
      const currentPrice = getProductPrice(products[productId]);
      if (!Number.isFinite(currentPrice) || currentPrice > Number(alert.targetPrice)) continue;
      const notificationKey = db.ref(`users/${userId}/notifications`).push().key;
      updates[`users/${userId}/notifications/${notificationKey}`] = {
        type: 'price_alert',
        title: 'Price alert triggered',
        message: `${safeString(products[productId]?.title, 160)} is now ${currentPrice} or below your target.`,
        productId,
        createdAt: new Date().toISOString(),
        read: false
      };
      updates[`priceAlerts/${userId}/${productId}/active`] = false;
      updates[`priceAlerts/${userId}/${productId}/triggeredAt`] = new Date().toISOString();
      triggered++;
    }
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
  return triggered;
}

async function startCouponCleanup() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  try {
    const count = await cleanupExpiredCoupons();
    const alerts = await scanPriceAlerts();
    if (count) console.log(`Automatically removed ${count} coupon(s)`);
    if (alerts) console.log(`Triggered ${alerts} price alert(s)`);
  } catch (error) {
    console.error('Scheduled maintenance failed:', error.message);
  }
}

async function callOxaPay(pathname, options = {}) {
  const key = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!key) throw Object.assign(new Error('OXAPAY_MERCHANT_API_KEY is not configured'), { statusCode: 503 });
  const response = await fetch(`${OXAPAY_API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      merchant_api_key: key,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { message: raw }; }
  if (!response.ok || (data.status !== undefined && Number(data.status) >= 400)) {
    const detail = data?.error?.message || data?.message || `OxaPay request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { statusCode: 502, gateway: data });
  }
  return data;
}

function gatewayData(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}

function isPaidStatus(status) {
  return ['PAID', 'COMPLETED', 'CONFIRMED'].includes(String(status || '').toUpperCase());
}

function isPayingStatus(status) {
  return ['PAYING', 'PENDING', 'CONFIRMING'].includes(String(status || '').toUpperCase());
}

function isExactAmount(receivedAmount, expectedAmount) {
  return Number.isFinite(Number(receivedAmount)) && cents(receivedAmount) === cents(expectedAmount);
}

function isGatewayPaymentExact(gateway, expectedAmount) {
  if (!isExactAmount(gateway?.amount, expectedAmount)) return false;
  const expectedCryptoValue = Number(gateway?.value);
  const sentCryptoValue = Number(gateway?.sent_value);
  if (Number.isFinite(expectedCryptoValue) && Number.isFinite(sentCryptoValue)) {
    return sentCryptoValue + 1e-12 >= expectedCryptoValue;
  }
  return true;
}

function amountMismatchError() {
  return Object.assign(new Error('Payment amount was not verified as the exact order total'), { statusCode: 422, code: 'amount_mismatch' });
}

function buildCallbackUrl() {
  if (!PUBLIC_BASE_URL) throw Object.assign(new Error('PUBLIC_BASE_URL is not configured'), { statusCode: 503 });
  return `${PUBLIC_BASE_URL}/api/oxapay/webhook`;
}

function buildReturnUrl(sessionId) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/User.html?payment=return&session=${encodeURIComponent(sessionId)}` : undefined;
}

async function reserveCreditsForSession(userId, sessionId, creditCents) {
  if (!creditCents) return { committed: true };
  const creditsRef = getDatabase().ref(`users/${userId}/storeCreditsCents`);
  const reservationRef = getDatabase().ref(`users/${userId}/creditReservations/${sessionId}`);
  const transaction = await creditsRef.transaction(current => {
    const balance = Math.max(0, Number(current || 0));
    if (balance < creditCents) return;
    return balance - creditCents;
  });
  if (!transaction.committed) return transaction;
  await reservationRef.set({ creditCents, reservedAt: new Date().toISOString() });
  return transaction;
}

async function releaseCreditReservation(userId, sessionId) {
  const reservationRef = getDatabase().ref(`users/${userId}/creditReservations/${sessionId}`);
  const snapshot = await reservationRef.once('value');
  if (!snapshot.exists()) return;
  const creditCents = Math.max(0, Number(snapshot.val()?.creditCents || 0));
  if (creditCents) {
    await getDatabase().ref(`users/${userId}/storeCreditsCents`).transaction(current => Math.max(0, Number(current || 0) + creditCents));
  }
  await reservationRef.remove();
}

async function consumeCreditReservation(userId, sessionId) {
  await getDatabase().ref(`users/${userId}/creditReservations/${sessionId}`).remove();
}

async function redeemRewardPoints(user, body) {
  const requestedPoints = Math.floor(Number(body.points || 0));
  if (!Number.isFinite(requestedPoints) || requestedPoints < 100 || requestedPoints % 100 !== 0) {
    throw Object.assign(new Error('Redeem points in multiples of 100. The minimum redemption is 100 points.'), { statusCode: 400 });
  }
  const rewardsRef = getDatabase().ref(`users/${user.uid}/rewards`);
  const transaction = await rewardsRef.transaction(current => {
    const points = Number(current?.points || 0);
    if (points < requestedPoints) return;
    return { ...(current || {}), points: points - requestedPoints, updatedAt: new Date().toISOString() };
  });
  if (!transaction.committed) throw Object.assign(new Error('You do not have enough reward points'), { statusCode: 409 });
  await getDatabase().ref(`users/${user.uid}/storeCreditsCents`).transaction(current => Math.max(0, Number(current || 0) + requestedPoints));
  await getDatabase().ref(`users/${user.uid}/rewardLedger`).push({ amount: -requestedPoints, reason: 'points_redeemed_for_store_credit', metadata: { storeCreditsCents: requestedPoints }, createdAt: new Date().toISOString() });
  return { points: Number(transaction.snapshot.val()?.points || 0), storeCreditsCents: Number((await getDatabase().ref(`users/${user.uid}/storeCreditsCents`).once('value')).val() || 0) };
}

async function createInvoice(user, body) {
  const maintenanceSnapshot = await getDatabase().ref('meta/store/maintenance').once('value');
  if (maintenanceSnapshot.exists() && maintenanceSnapshot.val() === true) {
    throw Object.assign(new Error('New checkouts are temporarily paused. Please try again shortly.'), { statusCode: 503, code: 'store_maintenance' });
  }
  if (!PUBLIC_BASE_URL) throw Object.assign(new Error('Set PUBLIC_BASE_URL to the public HTTPS URL of this app before creating payments'), { statusCode: 503 });
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    throw Object.assign(new Error('Add at least one product to the cart'), { statusCode: 400 });
  }

  const productMap = await getProductMap();
  const uniqueIds = [...new Set(body.items.map(item => safeString(item?.id, 200)).filter(Boolean))];
  const items = [];
  for (const productId of uniqueIds) {
    const product = productMap[productId];
    const price = getProductPrice(product);
    if (!product || !Number.isFinite(price) || price <= 0) {
      throw Object.assign(new Error('One or more products are no longer available for purchase'), { statusCode: 400 });
    }
    items.push({
      orderId: getDatabase().ref('orders').push().key,
      productId,
      title: safeString(product.title, 200),
      description: safeString(product.description, 500),
      imageUrl: safeString(product.imageUrl, 2000),
      downloadLink: safeString(product.downloadLink, 2000),
      discountedPrice: price,
      realPrice: Number(product.realPrice || price)
    });
  }
  if (!items.length) throw Object.assign(new Error('No paid products found in the cart'), { statusCode: 400 });

  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.discountedPrice, 0));
  let couponSnapshot = null;
  const couponCode = safeString(body.couponCode, 40).toUpperCase();
  if (couponCode) {
    const coupon = await findCoupon(couponCode);
    const discount = getCouponDiscount(coupon, subtotal);
    if (!discount) throw Object.assign(new Error('This coupon is invalid, expired, inactive, or no longer available'), { statusCode: 400 });
    couponSnapshot = discount;
  }
  const discountAmount = couponSnapshot?.discountAmount || 0;
  const requestedCreditCents = body.useCredits ? Math.max(0, cents(body.creditAmount || 0)) : 0;
  const creditBalanceSnapshot = requestedCreditCents ? await getDatabase().ref(`users/${user.uid}/storeCreditsCents`).once('value') : null;
  const availableCreditCents = creditBalanceSnapshot?.exists() ? Math.max(0, Number(creditBalanceSnapshot.val() || 0)) : 0;
  const creditCents = Math.min(requestedCreditCents, availableCreditCents, Math.max(0, cents(subtotal - discountAmount) - 1));
  const creditAmount = creditCents / 100;
  const total = roundMoney(Math.max(0, subtotal - discountAmount - creditAmount));
  if (total <= 0) throw Object.assign(new Error('Store credits cannot be used to make the invoice free. Use the free checkout instead.'), { statusCode: 400 });

  const sessionRef = getDatabase().ref('paymentSessions').push();
  const sessionId = sessionRef.key;
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    userId: user.uid,
    userEmail: safeString(user.email, 320),
    items,
    subtotal,
    discountAmount,
    creditAmount,
    creditCents,
    total,
    currency: 'USD',
    coupon: couponSnapshot,
    status: 'awaiting_payment',
    createdAt: now,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };
  await sessionRef.set(session);

  try {
    if (couponSnapshot?.id) {
      const reservation = await reserveCouponForSession(couponSnapshot.id, sessionId, session);
      if (!reservation.committed) {
        throw Object.assign(new Error('This coupon was just used by another checkout. Please refresh and try again.'), { statusCode: 409 });
      }
    }
    if (creditCents) {
      const creditReservation = await reserveCreditsForSession(user.uid, sessionId, creditCents);
      if (!creditReservation.committed) throw Object.assign(new Error('The requested store credit is no longer available'), { statusCode: 409 });
    }
    const invoice = await callOxaPay('/payment/invoice', {
      method: 'POST',
      body: {
        amount: total,
        currency: 'USD',
        lifetime: 60,
        fee_paid_by_payer: 0,
        under_paid_coverage: 0,
        mixed_payment: false,
        callback_url: buildCallbackUrl(),
        return_url: buildReturnUrl(sessionId),
        email: safeString(user.email, 320),
        order_id: sessionId,
        description: `Cipher Store purchase ${sessionId}`,
        sandbox: OXAPAY_SANDBOX
      }
    });
    const data = gatewayData(invoice);
    const trackId = safeString(data.track_id, 200);
    const paymentUrl = safeString(data.payment_url, 2000);
    if (!trackId || !paymentUrl) throw new Error('OxaPay did not return a payment link');
    await sessionRef.update({
      trackId,
      paymentUrl,
      gatewayCreatedAt: data.date || Math.floor(Date.now() / 1000),
      gatewayExpiresAt: data.expired_at || null
    });
    return { sessionId, trackId, paymentUrl, amount: total, subtotal, discountAmount, creditAmount, currency: 'USD', expiresAt: data.expired_at ? new Date(Number(data.expired_at) * 1000).toISOString() : session.expiresAt };
  } catch (error) {
    if (couponSnapshot?.id) await releaseCouponReservation(couponSnapshot.id, sessionId).catch(() => {});
    if (creditCents) await releaseCreditReservation(user.uid, sessionId).catch(() => {});
    await sessionRef.update({ status: 'failed', failureReason: safeString(error.message, 500), failedAt: new Date().toISOString() }).catch(() => {});
    throw error;
  }
}

async function finalizePaidSession(sessionId, gatewayPayload = {}, source = 'webhook') {
  const db = getDatabase();
  const sessionSnapshot = await db.ref(`paymentSessions/${sessionId}`).once('value');
  if (!sessionSnapshot.exists()) throw Object.assign(new Error('Payment session not found'), { statusCode: 404 });
  const session = sessionSnapshot.val();
  if (session.status === 'confirmed') return session;
  if (session.status === 'cancelled') throw Object.assign(new Error('Payment session is cancelled'), { statusCode: 409 });

  const gateway = gatewayData(gatewayPayload);
  const gatewayTrackId = safeString(gateway.track_id, 200);
  if (session.trackId && gatewayTrackId && gatewayTrackId !== session.trackId) {
    throw Object.assign(new Error('Payment track ID does not match this session'), { statusCode: 400 });
  }
  if (gateway.order_id && safeString(gateway.order_id, 200) !== sessionId) {
    throw Object.assign(new Error('Payment order ID does not match this session'), { statusCode: 400 });
  }
  const gatewayAmount = Number(gateway.amount);
  if (!isGatewayPaymentExact(gateway, session.total)) {
    throw amountMismatchError();
  }

  let couponRedemption = 'not_applicable';
  if (session.coupon?.id) {
    const couponRef = db.ref(`coupons/${session.coupon.id}`);
    const transaction = await couponRef.transaction(current => {
      if (current === null) return;
      const redemptions = current.redemptions || {};
      if (redemptions[sessionId]) return current;
      const reservations = { ...(current.reservations || {}) };
      const hadReservation = Boolean(reservations[sessionId]);
      if (!hadReservation) {
        const usageLimit = Number(current.usageLimit || 0);
        const usedCount = Number(current.usedCount || 0);
        if (usageLimit > 0 && usedCount >= usageLimit) return;
      }
      delete reservations[sessionId];
      const nextUsedCount = Number(current.usedCount || 0) + 1;
      redemptions[sessionId] = {
        userId: session.userId,
        orderIds: session.items.map(item => item.orderId),
        redeemedAt: new Date().toISOString()
      };
      if (current.autoDelete !== false && Number(current.usageLimit || 0) > 0 && nextUsedCount >= Number(current.usageLimit)) return null;
      return {
        ...current,
        usedCount: nextUsedCount,
        reservedCount: hadReservation ? Math.max(0, Number(current.reservedCount || 0) - 1) : Number(current.reservedCount || 0),
        reservations,
        redemptions
      };
    });
    if (transaction.committed) {
      couponRedemption = 'recorded';
    } else {
      const latestCoupon = await couponRef.once('value');
      const latestRedemption = latestCoupon.exists() && latestCoupon.val()?.redemptions?.[sessionId];
      if (!latestRedemption) throw Object.assign(new Error('Coupon is no longer available for this paid session'), { statusCode: 409 });
      couponRedemption = 'recorded';
    }
  }

  const purchasedAt = new Date().toISOString();
  const updates = {};
  const subtotal = Number(session.subtotal || 0);
  const subtotalCents = cents(subtotal);
  const discountCents = cents(session.discountAmount || 0);
  let allocatedDiscountCents = 0;
  const sessionItems = session.items || [];
  for (const [index, item] of sessionItems.entries()) {
    const itemCents = cents(item.discountedPrice || 0);
    const proportionalShare = subtotalCents > 0 ? Math.floor(discountCents * itemCents / subtotalCents) : 0;
    const itemDiscountCents = index === sessionItems.length - 1 ? Math.max(0, discountCents - allocatedDiscountCents) : proportionalShare;
    allocatedDiscountCents += itemDiscountCents;
    const finalAmount = Math.max(0, itemCents - itemDiscountCents) / 100;
    updates[`orders/${item.orderId}`] = {
      productId: item.productId,
      userId: session.userId,
      userEmail: session.userEmail,
      amountPaid: Number(session.total || 0),
      finalAmount,
      orderTotal: Number(session.total || 0),
      paymentProvider: 'oxapay',
      paymentStatus: 'paid',
      paymentTrackId: session.trackId || safeString(gateway.track_id, 200),
      productSnapshot: {
        title: item.title,
        description: item.description,
        imageUrl: item.imageUrl,
        downloadLink: item.downloadLink,
        discountedPrice: item.discountedPrice,
        realPrice: item.realPrice
      },
      couponUsed: session.coupon?.code || null,
      discountAmount: Number(session.discountAmount || 0),
      couponRedemption,
      userInput: { name: safeString(session.userEmail, 320), email: safeString(session.userEmail, 320) },
      status: 'confirmed',
      createdAt: session.createdAt,
      confirmedAt: purchasedAt,
      verifiedAt: purchasedAt,
      verificationSource: source,
      gatewayStatus: safeString(gateway.status, 80)
    };
    updates[`users/${session.userId}/purchases/${item.orderId}`] = {
      orderId: item.orderId,
      productId: item.productId,
      purchasedAt,
      status: 'confirmed',
      accessGranted: true,
      paymentProvider: 'oxapay',
      paymentTrackId: session.trackId || safeString(gateway.track_id, 200)
    };
    const notificationKey = db.ref(`users/${session.userId}/notifications`).push().key;
    updates[`users/${session.userId}/notifications/${notificationKey}`] = {
      type: 'purchase_confirmed',
      title: 'Purchase confirmed',
      message: `${safeString(item.title, 160)} is now available in your purchase library.`,
      orderId: item.orderId,
      productId: item.productId,
      createdAt: purchasedAt,
      read: false
    };
  }
  updates[`paymentSessions/${sessionId}`] = {
    ...session,
    status: 'confirmed',
    paymentStatus: 'paid',
    confirmedAt: purchasedAt,
    verifiedAt: purchasedAt,
    verificationSource: source,
    gateway: {
      trackId: safeString(gateway.track_id || session.trackId, 200),
      status: safeString(gateway.status, 80),
      amount: Number.isFinite(gatewayAmount) ? gatewayAmount : null,
      currency: safeString(gateway.currency || session.currency, 20),
      txs: Array.isArray(gateway.txs) ? gateway.txs.slice(0, 10) : []
    }
  };
  await db.ref().update(updates);
  if (session.creditCents) await consumeCreditReservation(session.userId, sessionId).catch(() => {});
  await awardPurchaseRewards(session.userId, session.items?.[0]?.orderId || sessionId);
  return updates[`paymentSessions/${sessionId}`];
}

async function refreshPaymentStatus(sessionId, session) {
  if (!session.trackId || session.status === 'confirmed') return session;
  try {
    const payload = await callOxaPay(`/payment/${encodeURIComponent(session.trackId)}`);
    const data = gatewayData(payload);
    const status = safeString(data.status, 80);
    if (isPaidStatus(status)) {
      try {
        return await finalizePaidSession(sessionId, data, 'status_api');
      } catch (error) {
        if (error.code === 'amount_mismatch') {
          const mismatch = { paymentStatus: 'amount_mismatch', paymentFailureReason: error.message, lastCheckedAt: new Date().toISOString() };
          await getDatabase().ref(`paymentSessions/${sessionId}`).update(mismatch);
          return { ...session, ...mismatch };
        }
        throw error;
      }
    }
    if (isPayingStatus(status)) {
      await getDatabase().ref(`paymentSessions/${sessionId}`).update({ paymentStatus: status.toLowerCase(), lastCheckedAt: new Date().toISOString() });
      return { ...session, paymentStatus: status.toLowerCase(), lastCheckedAt: new Date().toISOString() };
    }
    return session;
  } catch (error) {
    if (error.statusCode === 404) throw error;
    return session;
  }
}

function safeSession(session) {
  return {
    sessionId: session.id,
    status: session.status,
    paymentStatus: session.paymentStatus || session.status,
    trackId: session.trackId || null,
    paymentUrl: session.paymentUrl || null,
    amount: Number(session.total || 0),
    currency: session.currency || 'USD',
    createdAt: session.createdAt,
    expiresAt: session.gatewayExpiresAt ? new Date(Number(session.gatewayExpiresAt) * 1000).toISOString() : session.expiresAt,
    confirmedAt: session.confirmedAt || null,
    paymentFailureReason: session.paymentFailureReason ? safeString(session.paymentFailureReason, 200) : null,
    orderIds: (session.items || []).map(item => item.orderId)
  };
}

async function getPaymentSession(req, sessionId, shouldRefresh = true) {
  const user = await requireUser(req);
  const snapshot = await getDatabase().ref(`paymentSessions/${sessionId}`).once('value');
  if (!snapshot.exists()) throw Object.assign(new Error('Payment session not found'), { statusCode: 404 });
  let session = snapshot.val();
  if (session.userId !== user.uid) throw Object.assign(new Error('You cannot access this payment session'), { statusCode: 403 });
  if (shouldRefresh && session.status !== 'confirmed') {
    const expiresAt = new Date(session.expiresAt || 0).getTime();
    if (expiresAt && expiresAt <= Date.now()) {
      if (session.coupon?.id) await releaseCouponReservation(session.coupon.id, sessionId).catch(() => {});
      await getDatabase().ref(`paymentSessions/${sessionId}`).update({ status: 'expired', paymentStatus: 'expired', expiredAt: new Date().toISOString() });
      session = { ...session, status: 'expired', paymentStatus: 'expired' };
    } else {
      session = await refreshPaymentStatus(sessionId, session);
    }
  }
  return { user, session };
}

async function claimFreeProduct(user, body) {
  const productId = safeString(body.productId, 200);
  if (!productId) throw Object.assign(new Error('Product ID is required'), { statusCode: 400 });
  const productSnapshot = await getDatabase().ref(`products/${productId}`).once('value');
  if (!productSnapshot.exists()) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  const product = productSnapshot.val();
  if (getProductPrice(product) !== 0) throw Object.assign(new Error('This product is not free'), { statusCode: 400 });

  const purchasesSnapshot = await getDatabase().ref(`users/${user.uid}/purchases`).once('value');
  if (purchasesSnapshot.exists()) {
    for (const purchase of Object.values(purchasesSnapshot.val())) {
      if (purchase.productId === productId) return { alreadyOwned: true, orderId: purchase.orderId };
    }
  }

  const orderId = getDatabase().ref('orders').push().key;
  const purchasedAt = new Date().toISOString();
  const order = {
    productId,
    userId: user.uid,
    userEmail: safeString(user.email, 320),
    amountPaid: 0,
    finalAmount: 0,
    orderTotal: 0,
    paymentProvider: 'free',
    paymentStatus: 'not_required',
    productSnapshot: {
      title: safeString(product.title, 200),
      description: safeString(product.description, 500),
      imageUrl: safeString(product.imageUrl, 2000),
      downloadLink: safeString(product.downloadLink, 2000),
      discountedPrice: 0,
      realPrice: Number(product.realPrice || 0)
    },
    userInput: { name: safeString(user.email, 320), email: safeString(user.email, 320) },
    status: 'confirmed',
    createdAt: purchasedAt,
    confirmedAt: purchasedAt,
    verificationSource: 'free_claim'
  };
  const updates = {
    [`orders/${orderId}`]: order,
    [`users/${user.uid}/purchases/${orderId}`]: {
      orderId,
      productId,
      purchasedAt,
      status: 'confirmed',
      accessGranted: true,
      paymentProvider: 'free'
    }
  };
  await getDatabase().ref().update(updates);
  return { alreadyOwned: false, orderId };
}

async function getValidGameCoupons() {
  const snapshot = await getDatabase().ref('coupons').once('value');
  if (!snapshot.exists()) return [];
  const now = Date.now();
  return Object.entries(snapshot.val())
    .filter(([id, coupon]) => {
      if (!coupon?.isActive) return false;
      if (coupon.expiryDate && new Date(coupon.expiryDate).getTime() <= now) return false;
      const usageLimit = Number(coupon.usageLimit || 0);
      return !(usageLimit > 0 && Number(coupon.usedCount || 0) >= usageLimit);
    })
    .map(([id, coupon]) => ({ id, code: safeString(coupon.code, 40) }))
    .filter(coupon => coupon.code);
}

async function listProductReviews(productId) {
  const snapshot = await getDatabase().ref(`reviews/${productId}`).once('value');
  if (!snapshot.exists()) return { reviews: [], averageRating: 0, reviewCount: 0 };
  const reviews = Object.entries(snapshot.val()).map(([userId, review]) => ({
    id: userId,
    userId,
    displayName: safeString(review.displayName || 'Verified customer', 120),
    rating: Math.max(1, Math.min(5, Number(review.rating || 0))),
    comment: safeString(review.comment, 1000),
    verifiedPurchase: review.verifiedPurchase === true,
    createdAt: review.createdAt || null,
    updatedAt: review.updatedAt || review.createdAt || null
  })).filter(review => review.rating > 0).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 100);
  const averageRating = reviews.length ? roundMoney(reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) : 0;
  return { reviews, averageRating, reviewCount: reviews.length };
}

async function submitProductReview(user, body) {
  const productId = safeString(body.productId, 200);
  const rating = Number(body.rating);
  const comment = safeString(body.comment, 1000);
  if (!productId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw Object.assign(new Error('Choose a rating from 1 to 5 stars'), { statusCode: 400 });
  }
  if (comment.length < 3) throw Object.assign(new Error('Write at least a few words in your review'), { statusCode: 400 });
  const productSnapshot = await getDatabase().ref(`products/${productId}`).once('value');
  if (!productSnapshot.exists()) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  const purchasesSnapshot = await getDatabase().ref(`users/${user.uid}/purchases`).once('value');
  const ownsProduct = purchasesSnapshot.exists() && Object.values(purchasesSnapshot.val()).some(purchase => purchase.productId === productId && purchase.status === 'confirmed' && purchase.accessGranted !== false);
  if (!ownsProduct) throw Object.assign(new Error('Only verified customers can review this product'), { statusCode: 403 });
  const now = new Date().toISOString();
  const reviewRef = getDatabase().ref(`reviews/${productId}/${user.uid}`);
  const existing = await reviewRef.once('value');
  await reviewRef.set({
    rating,
    comment,
    displayName: safeString(user.name || user.displayName || user.email?.split('@')[0] || 'Verified customer', 120),
    verifiedPurchase: true,
    createdAt: existing.exists() ? existing.val().createdAt || now : now,
    updatedAt: now
  });
  return { ...(await listProductReviews(productId)), saved: true };
}

async function toggleWishlist(user, body) {
  const productId = safeString(body.productId, 200);
  if (!productId) throw Object.assign(new Error('Product ID is required'), { statusCode: 400 });
  const productSnapshot = await getDatabase().ref(`products/${productId}`).once('value');
  if (!productSnapshot.exists()) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  const itemRef = getDatabase().ref(`users/${user.uid}/wishlist/${productId}`);
  const existing = await itemRef.once('value');
  if (existing.exists()) {
    await itemRef.remove();
    return { saved: false };
  }
  await itemRef.set({ productId, addedAt: new Date().toISOString(), lastKnownPrice: getProductPrice(productSnapshot.val()) });
  return { saved: true };
}

async function savePriceAlert(user, body) {
  const productId = safeString(body.productId, 200);
  const targetPrice = Number(body.targetPrice);
  if (!productId || !Number.isFinite(targetPrice) || targetPrice < 0) {
    throw Object.assign(new Error('Product and a valid target price are required'), { statusCode: 400 });
  }
  const productSnapshot = await getDatabase().ref(`products/${productId}`).once('value');
  if (!productSnapshot.exists()) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
  await getDatabase().ref(`priceAlerts/${user.uid}/${productId}`).set({
    productId,
    targetPrice: roundMoney(targetPrice),
    currentPrice: getProductPrice(productSnapshot.val()),
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { saved: true, productId, targetPrice: roundMoney(targetPrice) };
}

async function getOrCreateReferralCode(user) {
  const userRef = getDatabase().ref(`users/${user.uid}`);
  const snapshot = await userRef.once('value');
  const profile = snapshot.exists() ? snapshot.val() : {};
  if (profile.referralCode) return profile.referralCode;
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    code = `CIPHER-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const codeSnapshot = await getDatabase().ref(`referralCodes/${code}`).once('value');
    if (!codeSnapshot.exists()) break;
  }
  await getDatabase().ref().update({
    [`users/${user.uid}/referralCode`]: code,
    [`referralCodes/${code}`]: { userId: user.uid, createdAt: new Date().toISOString() }
  });
  return code;
}

async function applyReferralCode(user, body) {
  const code = safeString(body.code, 40).toUpperCase();
  if (!code) throw Object.assign(new Error('Referral code is required'), { statusCode: 400 });
  const codeSnapshot = await getDatabase().ref(`referralCodes/${code}`).once('value');
  if (!codeSnapshot.exists()) throw Object.assign(new Error('Referral code not found'), { statusCode: 404 });
  const referrerId = safeString(codeSnapshot.val()?.userId, 200);
  if (!referrerId || referrerId === user.uid) throw Object.assign(new Error('You cannot use your own referral code'), { statusCode: 400 });
  const existing = await getDatabase().ref(`users/${user.uid}/referredBy`).once('value');
  if (existing.exists()) throw Object.assign(new Error('A referral code has already been applied to this account'), { statusCode: 409 });
  const now = new Date().toISOString();
  await getDatabase().ref().update({
    [`users/${user.uid}/referredBy`]: referrerId,
    [`users/${user.uid}/referralCodeUsed`]: code,
    [`users/${user.uid}/referredAt`]: now,
    [`users/${referrerId}/referrals/${user.uid}`]: { userId: user.uid, code, status: 'pending_purchase', createdAt: now }
  });
  return { applied: true };
}

async function incrementRewardPoints(userId, amount, reason, metadata = {}) {
  const rewardRef = getDatabase().ref(`users/${userId}/rewards`);
  let nextPoints = 0;
  const transaction = await rewardRef.transaction(current => {
    const currentData = current || {};
    nextPoints = Math.max(0, Number(currentData.points || 0) + Number(amount || 0));
    return {
      ...currentData,
      points: nextPoints,
      lifetimePoints: Math.max(0, Number(currentData.lifetimePoints || 0) + Math.max(0, Number(amount || 0))),
      updatedAt: new Date().toISOString()
    };
  });
  if (transaction.committed && amount !== 0) {
    await getDatabase().ref(`users/${userId}/rewardLedger`).push({ amount, reason: safeString(reason, 120), metadata, createdAt: new Date().toISOString() });
  }
  return nextPoints;
}

async function awardPurchaseRewards(userId, orderId) {
  try {
    await incrementRewardPoints(userId, 25, 'confirmed_purchase', { orderId });
    const referredBySnapshot = await getDatabase().ref(`users/${userId}/referredBy`).once('value');
    const referrerId = referredBySnapshot.exists() ? safeString(referredBySnapshot.val(), 200) : '';
    if (!referrerId) return;
    const referralRef = getDatabase().ref(`users/${referrerId}/referrals/${userId}`);
    const referralTransaction = await referralRef.transaction(current => {
      if (!current || current.status === 'qualified') return current;
      return { ...current, status: 'qualified', qualifiedOrderId: orderId, qualifiedAt: new Date().toISOString() };
    });
    if (referralTransaction.committed && referralTransaction.snapshot.val()?.status === 'qualified') {
      const rewardMarker = await getDatabase().ref(`users/${referrerId}/referralRewards/${userId}`).once('value');
      if (!rewardMarker.exists()) {
        await getDatabase().ref(`users/${referrerId}/referralRewards/${userId}`).set({ orderId, points: 100, createdAt: new Date().toISOString() });
        await incrementRewardPoints(referrerId, 100, 'qualified_referral', { referredUserId: userId, orderId });
      }
    }
  } catch (error) {
    console.error('Purchase reward processing failed:', error.message);
  }
}

async function playRewardGame(user, body) {
  const game = ['spin', 'scratch'].includes(safeString(body.game, 20)) ? safeString(body.game, 20) : 'spin';
  const now = Date.now();
  const validCoupons = (await getValidGameCoupons()).slice(0, 6);
  const reward = validCoupons.length && crypto.randomInt(100) < Math.min(55, 20 + validCoupons.length * 6)
    ? validCoupons[crypto.randomInt(validCoupons.length)]
    : null;
  const playRef = getDatabase().ref(`gamePlays/${user.uid}`);
  const play = await playRef.transaction(current => {
    const lastPlayed = Number(current?.lastPlayed || 0);
    if (lastPlayed && now - lastPlayed < GAME_ONE_DAY_MS) return;
    const playCount = Number(current?.playCount || 0) + 1;
    return {
      ...(current || {}),
      lastPlayed: now,
      lastGame: game,
      playCount,
      lastCoupon: reward?.code || null,
      lastRewardType: reward ? 'coupon' : 'points',
      lastPoints: reward ? 50 : 10,
      updatedAt: new Date(now).toISOString()
    };
  });
  if (!play.committed) throw Object.assign(new Error('This account has already used its daily game play'), { statusCode: 409 });
  const points = await incrementRewardPoints(user.uid, reward ? 50 : 10, `game_${game}`, { coupon: reward?.code || null });
  const playCount = Number(play.snapshot.val()?.playCount || 1);
  const achievementUpdates = {};
  if (playCount >= 1) achievementUpdates[`users/${user.uid}/achievements/first_game`] = { unlockedAt: new Date().toISOString(), title: 'First Game' };
  if (playCount >= 7) achievementUpdates[`users/${user.uid}/achievements/weekly_player`] = { unlockedAt: new Date().toISOString(), title: 'Weekly Player' };
  if (Object.keys(achievementUpdates).length) await getDatabase().ref().update(achievementUpdates);
  return { game, won: Boolean(reward), couponCode: reward?.code || null, points, nextPlayAt: new Date(now + GAME_ONE_DAY_MS).toISOString() };
}

async function getMemberOverview(user) {
  const db = getDatabase();
  const [profileSnapshot, purchasesSnapshot, wishlistSnapshot, alertsSnapshot, rewardsSnapshot, gameSnapshot, referralsSnapshot, notificationsSnapshot, downloadsSnapshot, achievementsSnapshot] = await Promise.all([
    db.ref(`users/${user.uid}`).once('value'),
    db.ref(`users/${user.uid}/purchases`).once('value'),
    db.ref(`users/${user.uid}/wishlist`).once('value'),
    db.ref(`priceAlerts/${user.uid}`).once('value'),
    db.ref(`users/${user.uid}/rewards`).once('value'),
    db.ref(`gamePlays/${user.uid}`).once('value'),
    db.ref(`users/${user.uid}/referrals`).once('value'),
    db.ref(`users/${user.uid}/notifications`).once('value'),
    db.ref(`users/${user.uid}/downloadHistory`).limitToLast(20).once('value'),
    db.ref(`users/${user.uid}/achievements`).once('value')
  ]);
  const profile = profileSnapshot.exists() ? profileSnapshot.val() : {};
  const purchases = purchasesSnapshot.exists() ? Object.values(purchasesSnapshot.val()) : [];
  const wishlist = wishlistSnapshot.exists() ? Object.values(wishlistSnapshot.val()) : [];
  const alerts = alertsSnapshot.exists() ? Object.values(alertsSnapshot.val()) : [];
  const referrals = referralsSnapshot.exists() ? Object.values(referralsSnapshot.val()) : [];
  const notifications = notificationsSnapshot.exists() ? Object.values(notificationsSnapshot.val()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 20) : [];
  const downloads = downloadsSnapshot.exists() ? Object.values(downloadsSnapshot.val()).sort((a, b) => new Date(b.downloadedAt || 0) - new Date(a.downloadedAt || 0)) : [];
  return {
    profile: { displayName: safeString(profile.displayName || user.name || user.email?.split('@')[0] || 'Customer', 120), email: safeString(user.email, 320), referralCode: await getOrCreateReferralCode(user), referredBy: profile.referredBy || null },
    purchases: purchases.slice(-50),
    wishlist: wishlist.slice(-100),
    priceAlerts: alerts.slice(-100),
    rewards: rewardsSnapshot.exists() ? rewardsSnapshot.val() : { points: 0, lifetimePoints: 0 },
    storeCreditsCents: Number(profile.storeCreditsCents || 0),
    game: gameSnapshot.exists() ? gameSnapshot.val() : {},
    achievements: achievementsSnapshot.exists() ? achievementsSnapshot.val() : {},
    referrals: referrals.slice(-100),
    notifications,
    downloads
  };
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const received = safeString(req.headers.hmac, 200).toLowerCase();
  const key = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!key || !received) return text(res, 401, 'Invalid signature');
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex').toLowerCase();
  const valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return text(res, 401, 'Invalid signature');
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return text(res, 400, 'Invalid JSON'); }
  if (safeString(payload.type, 80).toLowerCase() !== 'invoice') return text(res, 400, 'Invalid payment type');
  const data = gatewayData(payload);
  const eventId = crypto.createHash('sha256').update(rawBody).digest('hex');
  const eventRef = getDatabase().ref(`paymentEventDedupe/${eventId}`);
  const existingEvent = await eventRef.once('value');
  if (existingEvent.exists() && existingEvent.val()?.processedAt) return text(res, 200, 'OK');
  await eventRef.set({ status: safeString(data.status, 80), receivedAt: new Date().toISOString() });
  await getDatabase().ref('paymentEvents').push({
    sessionId: safeString(data.order_id, 200),
    trackId: safeString(data.track_id, 200),
    status: safeString(data.status, 80),
    amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    currency: safeString(data.currency, 20),
    receivedAt: new Date().toISOString(),
    source: 'oxapay_webhook'
  }).catch(error => console.error('Payment event audit write failed:', error.message));
  const sessionId = safeString(data.order_id, 200);
  if (!sessionId) return text(res, 400, 'Missing order_id');
  try {
    const snapshot = await getDatabase().ref(`paymentSessions/${sessionId}`).once('value');
    if (!snapshot.exists()) return text(res, 404, 'Unknown order_id');
    const session = snapshot.val();
    if (session.trackId && data.track_id && session.trackId !== data.track_id) return text(res, 400, 'Track ID mismatch');
    if (isPaidStatus(data.status)) {
      try {
        await finalizePaidSession(sessionId, data, 'webhook');
      } catch (error) {
        if (error.code !== 'amount_mismatch') throw error;
        await getDatabase().ref(`paymentSessions/${sessionId}`).update({ paymentStatus: 'amount_mismatch', paymentFailureReason: error.message, lastWebhookAt: new Date().toISOString() });
      }
    } else if (isPayingStatus(data.status)) {
      await getDatabase().ref(`paymentSessions/${sessionId}`).update({ paymentStatus: safeString(data.status, 80).toLowerCase(), lastWebhookAt: new Date().toISOString() });
    }
    await eventRef.update({ processedAt: new Date().toISOString() });
    return text(res, 200, 'OK');
  } catch (error) {
    await eventRef.remove().catch(() => {});
    console.error('Webhook processing failed:', error.message);
    return text(res, 500, 'Retry');
  }
}

async function downloadOwnedFile(req, res, orderId) {
  const user = await requireUser(req);
  const snapshot = await getDatabase().ref(`orders/${orderId}`).once('value');
  if (!snapshot.exists()) throw Object.assign(new Error('Purchase not found'), { statusCode: 404 });
  const order = snapshot.val();
  if (order.userId !== user.uid || order.status !== 'confirmed' || !['oxapay', 'free'].includes(order.paymentProvider)) {
    throw Object.assign(new Error('A confirmed purchase is required before downloading this file'), { statusCode: 403 });
  }
  const downloadLink = safeString(order.productSnapshot?.downloadLink, 2000);
  if (!downloadLink) throw Object.assign(new Error('This product does not have a download file yet'), { statusCode: 404 });
  let target;
  try { target = new URL(downloadLink); } catch { throw Object.assign(new Error('Product download link is invalid'), { statusCode: 502 }); }
  if (!['http:', 'https:'].includes(target.protocol)) throw Object.assign(new Error('Product download link is not allowed'), { statusCode: 502 });

  const upstream = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!upstream.ok) throw Object.assign(new Error('The product file is temporarily unavailable'), { statusCode: 502 });
  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > 50 * 1024 * 1024) throw Object.assign(new Error('The product file is too large to download through the store'), { statusCode: 413 });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > 50 * 1024 * 1024) throw Object.assign(new Error('The product file is too large to download through the store'), { statusCode: 413 });
  const filename = `${safeString(order.productSnapshot?.title, 80).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'cipher-store-download'}`;
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'Content-Length': buffer.length
  });
  await getDatabase().ref(`users/${user.uid}/downloadHistory`).push({
    orderId,
    productId: order.productId,
    productTitle: safeString(order.productSnapshot?.title, 200),
    downloadedAt: new Date().toISOString(),
    ipHash: crypto.createHash('sha256').update(safeString(req.socket.remoteAddress, 120)).digest('hex').slice(0, 16)
  }).catch(() => {});
  res.end(buffer);
}

function normalizeCode(value) {
  return safeString(value, 80).toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

async function createGiftCard(user, body) {
  const amountCents = cents(body.amount);
  if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 10000000) {
    throw Object.assign(new Error('Gift card amount must be between $1 and $100,000'), { statusCode: 400 });
  }
  const code = normalizeCode(body.code) || `CIPHER-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  if (code.length < 6) throw Object.assign(new Error('Gift card code is too short'), { statusCode: 400 });
  const ref = getDatabase().ref(`giftCards/${code}`);
  const result = await ref.transaction(current => {
    if (current) return;
    return {
      code,
      balanceCents: amountCents,
      originalBalanceCents: amountCents,
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: user.uid,
      expiresAt: body.expiresAt ? safeString(body.expiresAt, 40) : null
    };
  });
  if (!result.committed) throw Object.assign(new Error('That gift card code already exists'), { statusCode: 409 });
  await writeAudit(user, 'gift_card_created', { code, amountCents });
  return { code, amount: amountCents / 100 };
}

async function redeemGiftCard(user, body) {
  const code = normalizeCode(body.code);
  if (!code) throw Object.assign(new Error('Gift card code is required'), { statusCode: 400 });
  const cardRef = getDatabase().ref(`giftCards/${code}`);
  const result = await cardRef.transaction(current => {
    if (!current || current.active !== true || Number(current.balanceCents || 0) <= 0) return;
    if (current.expiresAt && new Date(current.expiresAt).getTime() <= Date.now()) return;
    return { ...current, active: false, redeemedBy: user.uid, redeemedAt: new Date().toISOString() };
  });
  if (!result.committed) throw Object.assign(new Error('This gift card is invalid, expired, or already redeemed'), { statusCode: 400 });
  const amountCents = Number(result.snapshot.val().balanceCents || 0);
  await getDatabase().ref(`users/${user.uid}/storeCreditsCents`).transaction(current => Number(current || 0) + amountCents);
  await getDatabase().ref(`users/${user.uid}/giftCards`).push({ code, amountCents, redeemedAt: new Date().toISOString() });
  await writeAudit(user, 'gift_card_redeemed', { code, amountCents });
  return { amount: amountCents / 100 };
}

async function updateProductChangelog(user, productId, body) {
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 50).map(entry => ({
    version: safeString(entry.version, 40),
    notes: safeString(entry.notes, 2000),
    releasedAt: safeString(entry.releasedAt || new Date().toISOString(), 40)
  })).filter(entry => entry.version && entry.notes) : [];
  if (!productId || !entries.length) throw Object.assign(new Error('At least one changelog entry is required'), { statusCode: 400 });
  const ref = getDatabase().ref(`products/${productId}/changelog`);
  await ref.set(entries);
  await writeAudit(user, 'product_changelog_updated', { productId, entryCount: entries.length });
  return { productId, entries };
}

async function getRewardOverview(user) {
  const db = getDatabase();
  const [profileSnapshot, rewardsSnapshot, usersSnapshot] = await Promise.all([
    db.ref(`users/${user.uid}/profile`).once('value'),
    db.ref(`users/${user.uid}/rewards`).once('value'),
    db.ref('users').once('value')
  ]);
  const profile = profileSnapshot.val() || {};
  const rewards = rewardsSnapshot.val() || {};
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = safeString(profile.lastLoginDay, 20);
  let streak = Number(profile.loginStreak || 0);
  if (lastDay !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    streak = lastDay === yesterday ? streak + 1 : 1;
    await db.ref(`users/${user.uid}/profile`).update({ loginStreak: streak, lastLoginDay: today });
    await db.ref(`users/${user.uid}/rewards/points`).transaction(current => Number(current || 0) + 10);
  }
  const leaderboard = Object.entries(usersSnapshot.val() || []).map(([uid, value]) => ({
    uid, displayName: safeString(value?.profile?.displayName || 'Customer', 80), points: Number(value?.rewards?.lifetimePoints || 0)
  })).sort((a, b) => b.points - a.points).slice(0, 20);
  return { streak, missions: [{ id: 'daily-login', title: 'Log in today', reward: 10, completed: lastDay === today }], points: Number(rewards.points || 0), leaderboard };
}

async function openMysteryBox(user) {
  const rewards = [25, 50, 100, 250];
  const reward = rewards[crypto.randomInt(rewards.length)];
  const ref = getDatabase().ref(`users/${user.uid}/rewards`);
  const result = await ref.transaction(current => {
    const points = Number(current?.points || 0);
    if (points < 50) return;
    return { ...(current || {}), points: points - 50 + reward, lifetimePoints: Number(current?.lifetimePoints || 0) + reward, updatedAt: new Date().toISOString() };
  });
  if (!result.committed) throw Object.assign(new Error('You need at least 50 points to open a mystery box'), { statusCode: 409 });
  await getDatabase().ref(`users/${user.uid}/rewardLedger`).push({ amount: reward - 50, reason: 'mystery_box', createdAt: new Date().toISOString() });
  return { cost: 50, reward, points: Number(result.snapshot.val()?.points || 0) };
}

async function saveNotificationPreferences(user, body) {
  const preferences = {
    priceAlerts: body.priceAlerts !== false,
    purchaseReceipts: body.purchaseReceipts !== false,
    gameRewards: body.gameRewards !== false,
    supportMessages: body.supportMessages !== false,
    updatedAt: new Date().toISOString()
  };
  await getDatabase().ref(`users/${user.uid}/notificationPreferences`).set(preferences);
  return preferences;
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, paymentConfigured: Boolean(process.env.OXAPAY_MERCHANT_API_KEY), publicUrlConfigured: Boolean(PUBLIC_BASE_URL), firebaseConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS) });
  }
  if (pathname === '/api/oxapay/webhook' && req.method === 'POST') return handleWebhook(req, res);

  if (pathname === '/api/payments/create-invoice' && req.method === 'POST') {
    enforceRateLimit(req, 'create-invoice', 8);
    const user = await requireUser(req);
    const body = await readJson(req);
    return json(res, 201, await createInvoice(user, body));
  }

  const paymentMatch = pathname.match(/^\/api\/payments\/([^/]+)(?:\/verify)?$/);
  if (paymentMatch && (req.method === 'GET' || req.method === 'POST')) {
    const sessionId = decodeURIComponent(paymentMatch[1]);
    const isVerify = pathname.endsWith('/verify');
    const { session } = await getPaymentSession(req, sessionId, true);
    return json(res, 200, safeSession(session));
  }

  if (pathname === '/api/library/claim-free' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readJson(req);
    return json(res, 201, await claimFreeProduct(user, body));
  }

  const reviewsMatch = pathname.match(/^\/api\/products\/([^/]+)\/reviews$/);
  if (reviewsMatch && req.method === 'GET') {
    return json(res, 200, await listProductReviews(decodeURIComponent(reviewsMatch[1])));
  }
  if (reviewsMatch && req.method === 'POST') {
    const user = await requireUser(req);
    return json(res, 201, await submitProductReview(user, await readJson(req)));
  }
  if (pathname === '/api/member/overview' && req.method === 'GET') {
    return json(res, 200, await getMemberOverview(await requireUser(req)));
  }
  if (pathname === '/api/member/wishlist/toggle' && req.method === 'POST') {
    return json(res, 200, await toggleWishlist(await requireUser(req), await readJson(req)));
  }
  if (pathname === '/api/member/price-alert' && req.method === 'POST') {
    return json(res, 201, await savePriceAlert(await requireUser(req), await readJson(req)));
  }
  if (pathname === '/api/member/referral-code' && req.method === 'GET') {
    const user = await requireUser(req);
    return json(res, 200, { referralCode: await getOrCreateReferralCode(user) });
  }
  if (pathname === '/api/member/referral-code' && req.method === 'POST') {
    return json(res, 201, await applyReferralCode(await requireUser(req), await readJson(req)));
  }
  if (pathname === '/api/member/redeem-points' && req.method === 'POST') {
    return json(res, 201, await redeemRewardPoints(await requireUser(req), await readJson(req)));
  }
  if (pathname === '/api/games/play' && req.method === 'POST') {
    return json(res, 201, await playRewardGame(await requireUser(req), await readJson(req)));
  }

  if (pathname === '/api/rewards/overview' && req.method === 'GET') {
    return json(res, 200, await getRewardOverview(await requireUser(req)));
  }
  if (pathname === '/api/rewards/mystery-box' && req.method === 'POST') {
    return json(res, 201, await openMysteryBox(await requireUser(req)));
  }
  if (pathname === '/api/member/notification-preferences' && req.method === 'GET') {
    const user = await requireUser(req);
    const snapshot = await getDatabase().ref(`users/${user.uid}/notificationPreferences`).once('value');
    return json(res, 200, snapshot.exists() ? snapshot.val() : { priceAlerts: true, purchaseReceipts: true, gameRewards: true, supportMessages: true });
  }
  if (pathname === '/api/member/notification-preferences' && req.method === 'PUT') {
    return json(res, 200, await saveNotificationPreferences(await requireUser(req), await readJson(req)));
  }
  if (pathname === '/api/gift-cards/create' && req.method === 'POST') {
    return json(res, 201, await createGiftCard(await requireAdmin(req), await readJson(req)));
  }
  if (pathname === '/api/gift-cards/redeem' && req.method === 'POST') {
    return json(res, 201, await redeemGiftCard(await requireUser(req), await readJson(req)));
  }
  const changelogMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)\/changelog$/);
  if (changelogMatch && req.method === 'PUT') {
    return json(res, 200, await updateProductChangelog(await requireAdmin(req), decodeURIComponent(changelogMatch[1]), await readJson(req)));
  }
  if (pathname === '/api/admin/audit-logs' && req.method === 'GET') {
    await requireAdmin(req);
    const snapshot = await getDatabase().ref('auditLogs').limitToLast(200).once('value');
    return json(res, 200, { logs: snapshot.exists() ? Object.values(snapshot.val()).reverse() : [] });
  }
  if (pathname === '/api/admin/payment-reconciliation' && req.method === 'GET') {
    await requireAdmin(req);
    const snapshot = await getDatabase().ref('paymentSessions').once('value');
    const sessions = snapshot.exists() ? Object.values(snapshot.val()) : [];
    return json(res, 200, {
      total: sessions.length,
      confirmed: sessions.filter(item => item.status === 'confirmed').length,
      pending: sessions.filter(item => item.status !== 'confirmed' && item.status !== 'failed' && item.status !== 'expired').length,
      mismatched: sessions.filter(item => item.paymentStatus === 'amount_mismatch').length,
      failed: sessions.filter(item => ['failed', 'expired'].includes(item.status)).length
    });
  }

  const downloadMatch = pathname.match(/^\/api\/library\/download\/([^/]+)$/);
  if (downloadMatch && req.method === 'GET') {
    return downloadOwnedFile(req, res, decodeURIComponent(downloadMatch[1]));
  }

  return null;
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'User.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('..') || relative.includes('\\')) return text(res, 400, 'Invalid path');
  const filePath = path.join(__dirname, relative);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return text(res, 404, 'Not found');
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.webmanifest' ? 'application/manifest+json' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url.pathname);
      if (handled !== null) return handled;
      return json(res, 404, { error: 'API route not found' });
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    if (statusCode >= 500) console.error('Request failed:', error.stack || error.message);
    return json(res, statusCode, { error: error.message || 'Internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Cipher Store server listening on http://localhost:${PORT}`);
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      startCouponCleanup();
      setInterval(startCouponCleanup, 60 * 60 * 1000);
    }
  });
}

module.exports = { server, roundMoney, cents, isExactAmount, isGatewayPaymentExact, getCouponDiscount, isPaidStatus, isPayingStatus, cleanupExpiredCoupons, getMemberOverview, listProductReviews, isExactAmount };
