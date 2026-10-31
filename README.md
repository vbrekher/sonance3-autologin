# Sonance AutoLogin

**Music on your Samsung TV, without typing a long password with the remote.**

Sonance AutoLogin is a small fork of [Sonance3](https://github.com/MrSimmo/sonance3). Build a version of the app for your own Navidrome server on your computer, then install it on your Samsung TV. Your server address and sign-in details are already there when the app opens.

You can run Navidrome at home, on a VPS or any other host. There's no cloud account or special hosting provider involved.

We didn't replace Sonance's interface. You still get albums, playlists, search, synced lyrics, the play queue, remote controls and the rest of the original player.

![Now playing in Sonance](screenshots/nowplaying.png)

## What's different here?

- **Set it up on your computer, not your TV.** Paste your server URL, username and password into a local script just once.
- **Choose how music plays.** The personal builder defaults to HTML5 Audio. The original Samsung AVPlay engine is still available as an option.
- **Keep your original Sonance app.** A personal build installs as a separate application named **Sonance AutoLogin**.
- **Pick your icon.** The builder gives you a square WGT and one with a wide TV home-screen tile.

That's it. Everything else stays close to Sonance3.

## Build your own app (macOS / Linux)

You need **Node.js 18 or newer**, plus **bash**, **zip**, **unzip** and **perl**. The standard Sonance build uses `npx` for its minifiers; the first run may download them.

~~~bash
git clone https://github.com/vbrekher/sonance3-autologin.git
cd sonance3-autologin
node scripts/build-personal.mjs
~~~

The script asks a few questions:

~~~text
Navidrome URL (include http:// or https://): https://music.example.com
Username: alex
Password (hidden; you can paste it):
Playback [H]TML5 / [A]VPlay (default H):
~~~

The password is entered without showing it in the terminal. A local address with a port works too, for example `http://192.168.1.20:4533`; so does a server under a URL path. Prefer HTTPS for servers reachable over the internet.

Your packages appear in `dist/`:

| File | Launcher |
| --- | --- |
| `Sonance-AutoLogin-Oblong.wgt` | Wide 16:9 home-screen tile |
| `Sonance-AutoLogin-Square.wgt` | Square icon |

Install **only one** of them. They have the same application ID.

## Install it on Samsung Tizen

1. Turn on Developer Mode on your TV.
2. Connect the TV and computer to the same network.
3. Open [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung).
4. Select your personal `.wgt` and install it. Re-sign it if the app asks.
5. Open **Sonance AutoLogin** on the TV.

The app will use the connection details you supplied while building. If they are invalid or your server is offline, Sonance may show its regular sign-in screen.

This is for Samsung TVs supported by upstream Sonance3 (Tizen 5.0+). The HTML5 workaround has worked on a Samsung UE43DU7100UXUA with Tizen 9. We have **not** tested every TV model or audio codec.

## Keep your build private

**Your personal WGT contains your server password in a readable form.** The password is also stored by the app in the TV's local storage. This is how sign-in without the remote works.

The build script runs on your own computer. It does not upload those details to GitHub or to us. Still, treat the finished WGT like a password:

- **Do not publish it** in Releases, Issues, Actions artifacts or anywhere else.
- Don't run personal builds in public CI.
- Use a separate, limited-permission Navidrome account for your TV if possible.
- If a personal WGT leaks, change its account password.

The `dist/` directory is ignored by Git. Generic upstream WGT files in the repository are not personalised; use the script to create yours.

## Playback: HTML5 or AVPlay?

The original Sonance uses Samsung AVPlay on a TV. On some setups, the library loads but a track sits at **00:00** without playing. Using HTML5 Audio fixed that symptom in a test on a Samsung Tizen 9 TV.

That's why HTML5 is the default **for personal builds**. The original app still uses AVPlay unless you deliberately select otherwise. HTML5 won't necessarily support every format or device, and this fork doesn't claim a universal fix.

If something doesn't play, check whether that same file works in the Samsung browser. When opening an issue, include your TV model, Tizen version, audio format and chosen backend — **never a stream URL containing authentication parameters**.

## Navidrome and Jellyfin

The personal auto-login builder is for **Navidrome / password-based Subsonic-compatible servers**. Original Sonance3 also supports Jellyfin, but Jellyfin's session flow is different: automatic Jellyfin setup is **not implemented** here yet.

## For developers

~~~bash
node --test tests/personal-build.test.mjs
~~~

The usual `./build.sh` still creates the generic Sonance packages. The personal builder builds in a temporary copy and doesn't write private credentials into your source checkout.

## Credit

All the hard work behind the music player comes from [MrSimmo's Sonance3](https://github.com/MrSimmo/sonance3) and its contributors. This is an independent community fork, not an official version. If you like it, please give the original project a star.

The code remains under [GNU GPL v3](LICENSE). If you redistribute modified binaries, include or provide access to the corresponding source code and keep the license notices.

[Инструкция на русском](docs/README.ru.md)
