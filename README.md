# Cipher Store

Cipher Store is a Firebase-backed storefront with a small Node.js service for operations that must not run in the browser. The service creates OxaPay invoices, verifies OxaPay callbacks, grants paid and free library access, and serves the two existing HTML pages.

## Secure configuration

Copy `.env.example` to `.env.local` and fill in the values on the server only. **Never put the OxaPay merchant key in `User.html`, `admin.html`, Firebase Realtime Database, GitHub, or browser-visible configuration.** The key provided for this integration should be rotated in OxaPay if it has been used anywhere public or committed to a repository.

Required values are:

```bash
OXAPAY_MERCHANT_API_KEY=replace_with_a_new_merchant_key
PUBLIC_BASE_URL=https://your-public-https-domain.example
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account", "project_id":"cipher-pro-store", "...":"..."}
FIREBASE_DATABASE_URL=https://cipher-pro-store-default-rtdb.firebaseio.com
```

Set `OXAPAY_SANDBOX=true` while testing. `PUBLIC_BASE_URL` must be the public HTTPS origin where this Node service is reachable. OxaPay will call `https://your-public-https-domain.example/api/oxapay/webhook`, and the storefront returns customers to `/User.html` after payment.

## Run locally

```bash
npm install
cp .env.example .env.local
npm start
```

Open `http://localhost:8787/` for the customer page and `http://localhost:8787/admin.html` for the admin page. Local payment callbacks require a public HTTPS tunnel; use the tunnel URL as `PUBLIC_BASE_URL` and point it to port `8787`.

## Payment behavior

The browser sends only a Firebase ID token and a cart snapshot to `POST /api/payments/create-invoice`. The service re-reads current product prices and coupon state from Firebase, calculates the total server-side, creates the OxaPay invoice, and stores a `paymentSessions/{sessionId}` record. The customer is redirected to the returned payment URL.

OxaPay callbacks are accepted only when the `HMAC` header matches an HMAC-SHA512 digest of the raw request body. The invoice amount is the exact server-calculated discounted total; `under_paid_coverage` is `0` and mixed payments are disabled. A payment is accepted only when OxaPay reports a final paid state and the gateway amount matches the stored total to the cent. If the gateway reports less than the exact amount, the session is marked `amount_mismatch`, no order is confirmed, and no file is unlocked. The service also supports an authenticated status check at `GET /api/payments/{sessionId}/verify`, so the storefront can recover if the callback arrives before the customer returns. Finalization is idempotent, stores confirmed `orders/{orderId}`, and writes the compatible `users/{uid}/purchases/{orderId}` purchase-library records.

## Coupons

Coupons support `autoDelete`. An automatically deleted coupon is removed when it expires or when its usage limit is reached. Checkout reserves a usage slot transactionally before creating the invoice, so concurrent customers cannot all receive the same limited coupon. Abandoned reservations are released when an invoice fails and are cleaned by the server’s periodic cleanup; final paid redemption atomically converts the reservation into a usage. The admin form exposes the setting and displays the resulting state.

## Notes

This repository originally contained only static HTML files. The new service is intentionally small and dependency-light, but it still needs a real deployment with Firebase Admin credentials and a public HTTPS URL before live OxaPay payments can be accepted. Paid and free downloads are routed through an authenticated server endpoint that checks the confirmed order before fetching the stored product file. Firebase client-side security rules should also restrict users to their own sessions and purchases and should prevent clients from changing order status, coupon usage, or product prices.


## Expanded feature suite

The current build includes a non-subscription member hub with purchase-library statistics, verified download history, notifications, reward points, achievements, daily game status, referral codes, referral qualification rewards, wishlist records, and price alerts. Product details expose verified customer reviews, wishlist actions, and price-alert controls. Only users with a confirmed purchase may submit a review.

The server-authoritative game endpoint is `POST /api/games/play`. It locks the daily play with a Firebase transaction and decides the coupon/points result on the server, so changing browser JavaScript cannot grant unlimited rewards. Confirmed OxaPay purchases award points and create purchase-confirmation notifications. Qualified referrals award points only after the referred account completes a verified purchase.

The admin dashboard now includes verified revenue, payment conversion, coupon savings, game plays, qualified referrals, lifetime reward points, recent gateway-event visibility, and JSON export of core store data. The Settings tab includes a server-enforced checkout maintenance switch. When enabled, new OxaPay invoices are rejected while confirmed downloads continue to work.

The Render service runs hourly maintenance when Firebase Admin credentials are configured. It removes expired or fully used auto-delete coupons, releases stale coupon reservations, and triggers active price alerts into each customer’s Firebase notification feed. For reliable scheduled execution, keep the Render Web Service running and configure the Firebase service-account environment variable.

## Important Firebase rules requirement

The browser still uses Firebase Auth for identity and Firebase Realtime Database for storefront reads. Before production, deploy Realtime Database Rules that prevent clients from writing `orders`, `paymentSessions`, `paymentEvents`, coupon counters, reward balances, referral rewards, or reviews for other users. The secure Node service is the authority for payment, purchases, rewards, referrals, and verified reviews.

### Granting administrator access

The admin page does not grant administrator access during browser setup. A signed-in account must have the Firebase custom claim `admin: true`; otherwise the page signs it out and protected writes are rejected by `rules.json`. After creating the account in Firebase Authentication, run this command on a trusted machine with the service-account JSON in `.env.local`:

```bash
npm run set-admin -- admin@example.com
```

Sign out and sign back in at `/admin.html` after running it. This enables product, coupon, order, settings, and support-message edits. Never put the service-account JSON in the browser or commit `.env.local`.

## Render production checklist

Set `OXAPAY_SANDBOX=false` only after a successful test payment. Set `PUBLIC_BASE_URL` to the exact HTTPS Render URL and configure OxaPay’s callback URL as `${PUBLIC_BASE_URL}/api/oxapay/webhook`. Set `ALLOWED_ORIGIN` to the real storefront origin rather than `*` when the frontend and API use different domains. Keep `FIREBASE_SERVICE_ACCOUNT_JSON` and `OXAPAY_MERCHANT_API_KEY` in Render’s private environment settings. Never upload `.env.local` or place the OxaPay key in HTML or browser JavaScript.
