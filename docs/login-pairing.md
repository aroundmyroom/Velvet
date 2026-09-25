# Pair a Device

Sign a device in — a Samsung TV, a kiosk, anything with an awkward
keyboard — without typing a password on it. The device shows a short code;
you approve it from a phone or computer that's already signed in.

This is separate from [Passkeys](#passkeys-vs-pairing) (WebAuthn), which
Velvet also supports — see below for which one to use where.

---

## On the device you're signing in (e.g. the TV)

1. Open the sign-in screen. Enter the **Server URL** as usual — you still
   need this, since the device has to know which Velvet server to talk to.
2. Instead of filling in a username and password, select **Pair with phone
   instead**.
3. A short code appears on screen, e.g. `S29 6A3`.

On the **Velvet TV** app for Samsung Tizen, this is right on the sign-in
screen — see [docs/tizen-tv.md](tizen-tv.md#3-first-run--connecting-to-your-server)
for the exact steps and remote-control navigation.

## On a device that's already signed in (your phone, laptop, ...)

1. Open Velvet in a browser, sign in as usual if you aren't already.
2. Go to **User Settings**, and find the **Pair a Device** section.
3. Type in the code shown on the other device and select **Approve**.

The other device signs itself in within a couple of seconds — nothing more
to do there.

## Things to know

- **The code is single-use and expires after 5 minutes.** If it expires
  before you approve it, go back to the device and start over — it'll show
  a fresh code.
- **You approve as yourself.** The device ends up signed in as whichever
  Velvet account approved the code — there's no separate "device account".
  If you want the TV to only see certain libraries, approve from an account
  that already has the access you want it to have.
- **The server URL still has to be typed once on the device.** Pairing
  removes the password, not the server address — the device has nowhere
  else to learn where your Velvet server is.
- Approving is its own action — declining is simply not entering the code,
  or letting it expire.

## Passkeys vs. pairing

Velvet has two passwordless sign-in options; use whichever fits the device:

| | **Passkeys** | **Pair a Device** |
|---|---|---|
| Best for | Phones, laptops, browsers with biometrics or a security key | TVs, kiosks — anything with no good way to type or scan |
| How it works | Face ID / fingerprint / Windows Hello / security key, registered per device | A code shown on one device, approved from another that's already signed in |
| Where to set up | User Settings → Passkeys | Nothing to set up in advance |

If a device's browser can do WebAuthn (most modern phones, laptops,
desktops), a passkey is usually the smoother option. Pairing exists for the
devices where that isn't realistic — most notably the Samsung Tizen TV app,
whose browser engine doesn't support the phone-as-security-key WebAuthn
flow.

---

See also: [docs/auth-reverse-proxy.md](auth-reverse-proxy.md) for signing in
automatically via a reverse proxy / SSO setup instead — a different feature
aimed at admins who already run something like Authelia or Authentik in
front of Velvet.
