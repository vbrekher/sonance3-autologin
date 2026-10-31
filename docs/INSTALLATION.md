# Install Sonance AutoLogin on a Samsung TV

This guide starts with a computer and a Samsung Tizen TV. Your Navidrome server can be local or hosted anywhere. You do **not** need Bunny or a special cloud account.

## Before you begin

You'll need:

- A Samsung TV compatible with Sonance3. Upstream supports Tizen 5.0 and newer; this fork has so far been tested on one Tizen 9 TV.
- A reachable Navidrome / password-based Subsonic-compatible server.
- Your own Navidrome username and password.
- A Mac or Linux computer with Node.js 18+, npm, bash, perl, zip and unzip.
- [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases) on your computer.

This project does not offer a shared, logged-in WGT. You need to make your own because your account details are different from everyone else's.

## 1. Prepare your Samsung TV

Samsung's official [TV device instructions](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html) cover Developer Mode:

1. On the TV, open **Apps** and the **App Settings** panel.
2. Enter **12345** using the remote or on-screen keypad.
3. Switch Developer Mode **On**.
4. Enter the **IP address of the computer** you're using to install the app (not the Navidrome server IP).
5. Restart the TV.

The computer and TV should be on the same local network. If the TV cannot be detected, check the IPs and restart once more.

## 2. Make your personal WGT

On the Mac or Linux computer:

~~~bash
git clone https://github.com/vbrekher/sonance3-autologin.git
cd sonance3-autologin
npm run build:personal
~~~

The first build may take longer because npm/npx downloads the minifiers used by the original Sonance build.

The questions are asked in this order:

~~~text
Navidrome URL (include http:// or https://): https://music.example.com
Username: alex
Playback [H]TML5 / [A]VPlay (default H):
Password (hidden; paste is fine):
~~~

A local server with a port is also fine (for example `http://192.168.1.20:4533`). HTTPS is strongly recommended over the internet.

**Password input is intentionally blank.** Paste it, press Enter, and continue. If your terminal shows the characters of the password, stop and report it as a bug without sending the password or a screenshot containing it.

When the build succeeds, look in `dist/`:

- `Sonance-AutoLogin-Oblong.wgt` — wide TV home tile.
- `Sonance-AutoLogin-Square.wgt` — square icon.

They are the same app ID. Use just one.

## 3. Install the WGT

1. Download and start [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases).
2. Pick your TV (or enter its IP if discovery doesn't find it).
3. Choose the **custom WGT/TPK** install option and select your file from `dist/`.
4. Let Apps2Samsung handle signing / re-signing if needed. It may ask you to sign in to your Samsung account for certificate creation.
5. Launch **Sonance AutoLogin** from the TV's Apps list.

[Apps2Samsung's project page](https://github.com/Apps2Samsung/Apps2Samsung) has more details about certificate handling and connection issues.

If the original Sonance3 is installed, you can leave it alone. AutoLogin uses a different Tizen application ID.

## 4. Check playback

Choose an album with two or more songs. Play the first track and let it finish naturally. The next song should start automatically.

If the library loads but a track is stuck at **00:00**, rebuild using the default **HTML5** option and compare the same track in the built-in Samsung browser. See [Troubleshooting](TROUBLESHOOTING.md).

## Update an existing personal installation

Update your local repository, then rebuild:

~~~bash
git pull --ff-only
npm run build:personal
~~~

Install the new WGT using Apps2Samsung. The username and password prompt is still on the computer. Don't share the new WGT.

If changing password or server, rebuild with the new values. Personal builds set their bundled credentials at app startup; changing them only inside the TV login screen won't permanently replace the bundled values.

## Windows

A native Windows build script is **not provided**. An advanced option is WSL2 with a Linux environment containing Node.js 18+, npm, bash, perl, zip and unzip. Run the normal build command inside WSL and then install the generated WGT with Windows Apps2Samsung. This route has not yet been tested by the maintainers, so Windows support is not claimed as verified.

## Private files

Never upload anything from `dist/` to GitHub. Your generated WGT contains credentials, even though the script doesn't print them. For more detail see [Security](../SECURITY.md).
