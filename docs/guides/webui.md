# WebUI Mode - Startup Guide

Pixebot Browser can run with an embedded web server, so you can use the app from a web browser, including from other devices on your network.

## Contents

- [What is WebUI mode?](#what-is-webui-mode)
- [Starting WebUI mode](#starting-webui-mode)
- [Remote access](#remote-access)
- [Environment variables](#environment-variables)
- [User configuration file](#user-configuration-file)
- [Command line options](#command-line-options)
- [Reset the admin password](#reset-the-admin-password)
- [Troubleshooting](#troubleshooting)

---

## What is WebUI mode?

WebUI mode starts the app with an embedded web server, which lets you:

- Use the app through any modern web browser
- Reach it from other devices on the same network (with the `--remote` flag)
- Run it headless on a server

Default port: **25808** in a packaged build, **25809** in development (`25810` for a second dev instance). If the port is taken, check the console output for the one actually used.

---

## Starting WebUI mode

Pass `--webui` to the app executable. The executable is named `PixebotBrowser`.

**Windows**

```cmd
"C:\Program Files\Pixebot Browser\PixebotBrowser.exe" --webui
```

**macOS**

```bash
/Applications/Pixebot\ Browser.app/Contents/MacOS/PixebotBrowser --webui
```

**Linux (.deb)**

```bash
/opt/Pixebot\ Browser/PixebotBrowser --webui
```

To start it in the background on Linux, create a systemd unit such as `/etc/systemd/system/pixebot-webui.service`:

```ini
[Unit]
Description=Pixebot Browser WebUI
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
ExecStart="/opt/Pixebot Browser/PixebotBrowser" --webui --remote
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pixebot-webui.service
```

From a source checkout, run `bun run start`; the WebUI is then served on the development port.

---

## Remote access

By default the server only listens on localhost. To reach it from other devices, add `--remote`:

```bash
PixebotBrowser --webui --remote
```

Then open `http://YOUR_IP_ADDRESS:25808` from the other device. Find your IP with `ipconfig` (Windows) or `ifconfig` / `ip addr show` (macOS/Linux); look for the `inet` / IPv4 address, e.g. `192.168.1.100`.

**Security note**: remote mode allows network access. Use it only on trusted networks and keep a firewall in front of it.

---

## Environment variables

```bash
# Override the listening port
export AIONUI_PORT=8080

# Allow remote access without passing --remote
export AIONUI_ALLOW_REMOTE=true

# Optional host hint (0.0.0.0 behaves the same as AIONUI_ALLOW_REMOTE=true)
export AIONUI_HOST=0.0.0.0
```

You can also pass the port on the command line: `--webui --port 8080`.

---

## User configuration file

Persistent WebUI preferences live in `webui.config.json` in the app's user-data folder:

| Platform | Location                                                          |
| -------- | ----------------------------------------------------------------- |
| Windows  | `%APPDATA%/Pixebot Browser/webui.config.json`                     |
| macOS    | `~/Library/Application Support/Pixebot Browser/webui.config.json` |
| Linux    | `~/.config/Pixebot Browser/webui.config.json`                     |

```json
{
  "port": 8080,
  "allowRemote": true
}
```

CLI flags take priority, then environment variables, then this file.

---

## Command line options

| Option            | Description                 |
| ----------------- | --------------------------- |
| `--webui`         | Start in WebUI mode         |
| `--remote`        | Allow remote network access |
| `--port <number>` | Listening port              |
| `--resetpass`     | Reset the admin password    |

---

## Reset the admin password

If you forgot the admin password, run the app executable with `--resetpass`:

```bash
PixebotBrowser --resetpass             # resets the default user, admin
PixebotBrowser --resetpass username    # resets a specific user
```

This generates a new random password, updates the stored hash, rotates the JWT secret (which invalidates all existing tokens) and prints the new password in the terminal. Copy it right away, refresh the browser and log in with it.

In a source checkout you can run `bun run resetpass` instead.

---

## Troubleshooting

**Cannot reach the page**

1. Check the console for the "Server started on port ..." message and use that port.
2. Try another browser, or clear the cache (`Ctrl+Shift+Delete` / `Cmd+Shift+Delete`).
3. For access from another device, make sure you started with `--remote` and your firewall allows the port.

**Firewall**

```cmd
:: Windows
netsh advfirewall firewall add rule name="Pixebot Browser WebUI" dir=in action=allow protocol=TCP localport=25808
```

```bash
# Linux (UFW)
sudo ufw allow 25808/tcp
```

On macOS, allow the app under System Settings -> Network -> Firewall.

**Save the log**

```bash
PixebotBrowser --webui 2>&1 | tee pixebot.log
```
