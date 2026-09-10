# Cipher Store feature rollout

## Existing protected foundation

The project currently contains a static customer storefront and admin page backed by Firebase Auth/Realtime Database, plus a Node.js service for OxaPay invoices, HMAC webhook verification, exact discounted-amount validation, coupon reservation and cleanup, paid/free purchase-library records, and authenticated downloads. The current customer page also has bookmarks, cart and coupon checkout, product screenshots, support chat, contact content, a purchase library, a spin wheel, and scratch cards.

## Requested additions excluding subscriptions

### Commerce and customer experience

Product reviews and verified ratings, wishlist improvements, price alerts, product tags and category discovery, related products, featured/new/popular sections, version history and changelogs, gift cards, promotional codes, store credits, referral rewards, customer profiles, receipts, failed-payment recovery, download history, and an installable PWA experience.

### Rewards and games

Daily login streaks, missions, achievements, leaderboards, reward points, mystery boxes, memory/reaction games, campaign scheduling, and server-authoritative reward issuance. Existing wheel and scratch-card daily limits must remain protected from browser tampering.

### Admin operations

Analytics for revenue, conversion, coupon usage, abandoned payments, products, game activity, referrals, credits, and support. Also add product bulk operations, version management, coupon campaign scheduling, customer search and moderation, ticket management, role-based admin controls, webhook event history, payment reconciliation, audit logs, and an emergency checkout switch.

### Reliability and automation

Webhook replay/idempotency logs, payment-session expiration handling, error logging, uptime/health checks, backup/export tools, expiring-coupon cleanup, reward abuse controls, notification preferences, and reminders for payment recovery, price alerts, and expiring game rewards.

## Rollout boundary

Subscriptions are explicitly excluded. All features must preserve the existing server-side payment calculation, exact OxaPay amount check, underpayment rejection, coupon concurrency protection, authenticated file delivery, and Firebase ownership boundaries.

## Deployment constraint

The current deployment target is Render Web Service for the Node.js server, with Firebase remaining the Auth and Realtime Database backend. Secrets remain Render environment variables; no OxaPay secret is placed in browser code or Firebase client configuration.

