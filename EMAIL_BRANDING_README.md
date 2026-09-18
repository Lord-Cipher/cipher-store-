# CIPHER TECH STORE Email Branding Setup

This guide explains how to make verification and password-recovery emails appear as **CIPHER TECH STORE** instead of Supabase.

## Where the sender name is changed

The sender identity is controlled in two places. The Supabase email templates control the visible message content and subject. The SMTP provider controls the sender address and authenticated delivery domain.

### Supabase dashboard

Open the project at [Supabase Dashboard](https://supabase.com/dashboard), then select the **CIPHER STORE** project.

Go to **Authentication → SMTP Settings** and configure a custom SMTP provider. Use a verified address such as:

```text
CIPHER TECH STORE <no-reply@yourdomain.com>
```

Replace `yourdomain.com` with a domain that you own and have verified. The Supabase default mail service may continue to display Supabase branding and is intended for development rather than dependable production delivery.

Next, go to **Authentication → Email Templates** and edit the templates used for:

- Confirm signup or email OTP.
- Magic link or email OTP.
- Reset password or password-recovery OTP.

Set the subjects to:

```text
CIPHER TECH STORE email verification code
CIPHER TECH STORE password recovery code
```

The HTML templates must include the following token placeholder:

```text
{{ .Token }}
```

The application verifies this six-digit token with Supabase `verifyOtp`. Removing the placeholder prevents code-based verification from working.

## Where the logo is changed

The source logo is stored in the repository at:

```text
assets/cipher-tech-logo.png
```

It is served publicly after deployment at:

```text
https://YOUR-RENDER-DOMAIN/assets/cipher-tech-logo.png
```

The branded template should reference it as:

```html
<img src="{{ .SiteURL }}/assets/cipher-tech-logo.png" alt="CIPHER TECH STORE" width="150">
```

If `{{ .SiteURL }}` resolves to the Supabase URL instead of the Render URL, replace it with the full public Render URL. The image must be reachable over HTTPS; otherwise email clients will not display it.

The repository also contains complete HTML templates in [`supabase-email-templates.md`](supabase-email-templates.md).

## DNS records for delivery

After adding a sending domain to your SMTP provider, publish every DNS record supplied by that provider. These normally include SPF and DKIM. Add DMARC after SPF and DKIM are passing. DNS records are changed at the registrar or DNS host for your domain, not in the Cipher Store repository.

A typical production sender might be:

```text
CIPHER TECH STORE <receipts@ciphertechstore.com>
```

Do not copy this address unless `ciphertechstore.com` is your verified domain.

## Resend configuration for purchase receipts

The application sends Stripe-style purchase receipts through Resend when these private Render variables are configured:

```text
RESEND_API_KEY=re_your_real_key
RESEND_FROM_EMAIL=CIPHER TECH STORE <receipts@your-verified-domain.com>
```

In Render, open the `cipher-store` web service, select **Environment**, add or update these variables, save, and redeploy. The Resend API key is obtained from **Resend Dashboard → API Keys**. The sender address must belong to a verified Resend domain.

## What can and cannot be guaranteed

The application can control the sender name, sender domain, logo, subject, and OTP text when custom SMTP and templates are configured. It cannot guarantee inbox placement because Gmail, Outlook, Yahoo, and other providers make independent spam decisions. Domain authentication, consistent sender identity, useful message content, and a low complaint rate improve delivery.

## Verification checklist

Send a test signup OTP and a password-recovery OTP to Gmail, Outlook, and Yahoo. Confirm that the sender shows **CIPHER TECH STORE**, the logo loads, the message includes a six-digit code, and the code works in the application. Then complete a sandbox purchase and confirm that the receipt shows the same sender identity.

## References

[1]: https://supabase.com/docs/guides/auth/auth-email "Supabase email authentication documentation"
[2]: https://supabase.com/docs/guides/auth/auth-smtp "Supabase custom SMTP documentation"
[3]: https://resend.com/docs/dashboard/domains/introduction "Resend domain verification documentation"
