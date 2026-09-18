# Cipher Store

Cipher Store is a Supabase-backed digital-tools marketplace with a Node.js service for operations that must not run in the browser. The service creates OxaPay invoices, verifies OxaPay callbacks, grants paid and free library access, and serves the customer and administrator pages.

## Secure configuration

Copy `.env.example` to `.env.local` and fill in values on the server only. Never put the OxaPay merchant key or Supabase service-role key in HTML, GitHub, or browser-visible configuration.

```bash
OXAPAY_MERCHANT_API_KEY=replace_with_a_rotated_merchant_key
OXAPAY_SANDBOX=true
PUBLIC_BASE_URL=https://your-public-https-domain.example
ALLOWED_ORIGIN=https://your-public-https-domain.example
SUPABASE_URL=https://ozhejjbfmltmimmzwpdv.supabase.co
SUPABASE_ANON_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

The publishable key may be exposed to the browser. The service-role key must remain private in Render and trusted local administration scripts.

## Authentication providers

Email/password authentication is supported by Supabase Auth. Google and GitHub buttons are included on both the customer and admin login screens. In the Supabase dashboard, open **Authentication → Providers**, enable **Google** and **GitHub**, and enter the provider client ID and secret. Add the deployed storefront URL and `/admin.html` to the provider redirect allow-list as needed. Supabase’s callback URL is shown in the provider settings and normally follows this form:

```text
https://ozhejjbfmltmimmzwpdv.supabase.co/auth/v1/callback
```

Also add the local and Render origins under **Authentication → URL Configuration → Redirect URLs**, for example `http://localhost:8787/**` and `https://your-render-host.onrender.com/**`.

## Branded email verification and deliverability

Email/password signup uses a six-digit OTP. The verification screen is branded **CIPHER TECH STORE** and accepts the code sent by Supabase Auth. In **Authentication → Email Templates → Confirm signup**, use a subject such as `CIPHER TECH STORE email verification` and include `{{ .Token }}` in the message. Do not remove the token placeholder or the code cannot be verified.

Forgot-password recovery also uses a six-digit email OTP. The user selects **Forgot password? Recover with email OTP**, verifies the code, and chooses a new password. Copy the branded HTML examples from [`supabase-email-templates.md`](supabase-email-templates.md) into the Supabase email templates so the emails show CIPHER TECH STORE instead of the default Supabase branding.

No application can guarantee that a message will never enter spam. To improve delivery, configure a custom SMTP provider and a branded sender address such as `no-reply@yourdomain.com`, then publish the provider’s SPF and DKIM DNS records. Add a DMARC policy after SPF and DKIM pass, use a verified sending domain, keep the sender name as `CIPHER TECH STORE`, and avoid sending from a free mailbox address. Test with Gmail, Outlook, and Yahoo before production.

## Run locally

```bash
npm install
cp .env.example .env.local
npm start
```

Open `http://localhost:8787/` for the customer page and `http://localhost:8787/admin.html` for the admin page. Local OxaPay callbacks require a public HTTPS URL.

## Supabase schema

The initial schema is applied to project `ozhejjbfmltmimmzwpdv` and includes profiles, products, coupons, payment sessions, orders, purchases, reviews, wishlists, price alerts, rewards, referral coins, notifications, gift cards, support tickets, download history, audit logs, and app settings. Row Level Security is enabled on customer-facing tables. The Node service uses the Supabase service role for payment verification and other privileged operations.

## Payment behavior

The browser sends an authenticated Supabase access token and cart snapshot to `POST /api/payments/create-invoice`. The service re-reads current product prices and coupon state, calculates the total server-side, creates the OxaPay invoice, and stores a payment-session record. OxaPay callbacks require a valid HMAC-SHA512 signature and exact amount matching; underpayments never unlock files.

## Features

The platform includes a non-subscription purchase library, verified-buyer reviews, invoices and printable receipts, referral links and referral coins, coin history and redemption, loyalty levels, daily games, coin-entry games, mystery boxes, gift-card gifting, product discovery filters, price alerts, broadcasts, support tickets, coupon campaigns, audit logs, and admin operations.

## Administrator access

Create the user in Supabase Auth, then run the trusted-machine command below with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` available:

```bash
npm run set-admin -- admin@example.com owner
```

Supported roles include `owner`, `admin`, and `manager`. The user must sign out and back in to refresh the session. Never expose the service-role key.

## Render checklist

Set the following private Render variables: `OXAPAY_MERCHANT_API_KEY`, `PUBLIC_BASE_URL`, `ALLOWED_ORIGIN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Keep `OXAPAY_SANDBOX=true` until a complete sandbox payment and webhook test succeeds. Configure OxaPay’s callback URL as `${PUBLIC_BASE_URL}/api/oxapay/webhook`.

Before production, verify authentication, product reads, admin writes, payment callbacks, exact-amount rejection, library downloads, referral coins, gift cards, broadcasts, and support tickets against the live Supabase project.

## Purchase receipt emails

Paid and free purchases create an in-app notification and can also send a branded, Stripe-style HTML receipt through Resend. Configure `RESEND_API_KEY` and a verified sender in `RESEND_FROM_EMAIL` in Render. The receipt includes the CIPHER TECH STORE logo, purchased products, discount, total paid, payment method, order references, timestamp, and a purchase-library link. If Resend is not configured, purchases still complete normally and the failure is written to the audit log rather than blocking access.
