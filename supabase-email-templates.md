# CIPHER TECH STORE Supabase email templates

Supabase will continue showing its default branding until these templates are replaced in **Authentication → Email Templates**.

## Sender configuration

Use a verified custom SMTP provider and set the sender name to:

```text
CIPHER TECH STORE
```

Use an address on the verified domain, such as `no-reply@ciphertechstore.com`.

## Confirm signup / email OTP

Subject:

```text
CIPHER TECH STORE email verification code
```

HTML body:

```html
<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;color:#0f172a">
  <div style="background:#071436;padding:24px;text-align:center;border-radius:12px 12px 0 0">
    <img src="{{ .SiteURL }}/assets/cipher-tech-logo.png" alt="CIPHER TECH STORE" width="150">
  </div>
  <div style="border:1px solid #e2e8f0;border-top:0;padding:28px;border-radius:0 0 12px 12px">
    <h1 style="font-size:22px">Verify your CIPHER TECH STORE email</h1>
    <p>Enter this one-time code to continue:</p>
    <div style="font-size:34px;letter-spacing:8px;font-weight:bold;color:#0284c7;padding:18px 0">{{ .Token }}</div>
    <p style="color:#64748b">This code expires according to your Supabase Auth email settings. If you did not request it, you can ignore this email.</p>
  </div>
</div>
```

## Password recovery OTP

Use the same branded layout under the password-recovery or magic-link template used by your Supabase Auth configuration. Keep `{{ .Token }}` in the email body because the application verifies the six-digit code with `verifyOtp`.

Subject:

```text
CIPHER TECH STORE password recovery code
```

The image URL requires the deployed application to serve `/assets/cipher-tech-logo.png` over HTTPS. Update `{{ .SiteURL }}` if the Supabase URL configuration does not match the Render application URL.

## Delivery requirements

Supabase’s default mail service is suitable for development but is not intended for dependable production delivery. Configure custom SMTP, verify the sending domain, publish SPF and DKIM records, add DMARC, and test Gmail, Outlook, and Yahoo. The application can request and verify OTPs, but it cannot control a recipient provider’s spam classification.
