---
name: aionui-webui-public
description: >-
  Help the user open their Pixebot Browser from outside their home or office network (from a phone, another city, or via a shareable link) using the built-in "Access from anywhere (secure link)" switch in Settings -> WebUI. Use for requests like "access my app remotely", "open it from my phone", "give me a public link", or "port forwarding". Guide the user to the switch; never install or run a tunnel tool yourself. LAN-only access is the separate "Allow Remote Access" switch.
---

# Pixebot Browser: access from anywhere

Pixebot Browser has a built-in way to get a secure link. You do not set anything up yourself. You guide the user to the switch, in their language and in plain terms.

## What to tell the user

1. Open **Settings -> WebUI**.
2. Turn on **WebUI** (the server must be running first).
3. Turn on **Access from anywhere (secure link)**.
4. Wait a few seconds. An `https://...trycloudflare.com` link appears, with a **copy** button and a **login QR code**.
5. Copy the link, or scan the QR code with the phone, and open it. Sign in with the WebUI username and password shown on the same page.

Only the WebUI switch is required. The tunnel does not need "Allow Remote Access".

## Hard rules

- NEVER download, install or run `cloudflared`, `ngrok` or any other tunnel or port-forwarding tool yourself.
- NEVER run shell commands to expose a port, edit router or firewall settings, or open the WebUI to the network.
- NEVER say the password is the only protection. Describe the real protections (below) accurately.
- If the switch is missing, off or shows an error, tell the user what it shows and ask them to retry from Settings. Do not work around it.

## What protects the link (state this briefly and accurately)

- Login is enforced on every API, WebSocket and streaming request, not just on the login page.
- Admin routes (`/api/webui/*` and `/api/auth/internal/*`) are blocked from the network.
- Requests are rate-limited per visitor, keyed on the real client IP.
- Traffic uses HTTPS through Cloudflare. Cloudflare terminates TLS, so it sits in the path.
- Changing the WebUI password signs out all other devices.

## Advice to give

- Use a strong, unique WebUI password, and change it from Settings -> WebUI if it is still the generated one.
- Keep the link private. Anyone who has it can reach the login page.
- The link changes every time the tunnel restarts (app restart, WebUI restart, or reconnect). Share the new link or QR code after that.
- The link works only while Pixebot Browser is running and the computer is awake. Turn the switch off when remote access is no longer needed.

## Same network only?

If the user only needs devices on the same Wi-Fi or LAN, point them to the separate **Allow Remote Access** switch in Settings -> WebUI. That gives a local network address and no internet link. For manual Tailscale or server setups, use the `aionui-webui-setup` skill.
