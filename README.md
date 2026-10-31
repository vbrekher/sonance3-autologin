<p align="center"><img src="screenshots/logo.png" alt="Sonance artwork" width="140"></p>

<h1 align="center">Sonance AutoLogin</h1>
<p align="center">Your music on your Samsung TV. No typing a long password with the remote.</p>
<p align="center"><a href="https://github.com/vbrekher/sonance3-autologin/actions/workflows/personal-build-tests.yml"><img src="https://github.com/vbrekher/sonance3-autologin/actions/workflows/personal-build-tests.yml/badge.svg" alt="Personal build tests"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a></p>
<p align="center">
  <a href="docs/INSTALLATION.md">Install guide</a> ·
  <a href="docs/README.ru.md">Русская инструкция</a> ·
  <a href="docs/TROUBLESHOOTING.md">Troubleshooting</a> ·
  <a href="https://github.com/MrSimmo/sonance3">Original Sonance3</a>
</p>

---

Sonance AutoLogin is a community fork of [Sonance3 by MrSimmo](https://github.com/MrSimmo/sonance3). It builds a personal Samsung Tizen app with **your own Navidrome server URL, username and password** already configured. Fill them in once on your computer, install the resulting WGT on the TV, and open your library.

Navidrome can be hosted at home, on a VPS, or anywhere else. **Bunny is not required.** No accounts with this project, no remote build service, and no typing credentials with the TV remote.

### See the player

<p align="center"><img src="screenshots/nowplaying.png" alt="Now Playing screen in Sonance3" width="880"></p>

| Browse albums | Explore playlists |
| :---: | :---: |
| <img src="screenshots/album.png" alt="Album screen" width="420"> | <img src="screenshots/playlists.png" alt="Playlists screen" width="420"> |

*Images are from the original Sonance3 player. The look and core library features are preserved in this fork.*

### What's different from Sonance3?

- **Personal WGT builder.** Enter the URL, username and password once on your Mac or Linux computer. The builder makes your own `.wgt` files.
- **HTML5 Audio on Samsung.** An alternative to Samsung AVPlay for TVs where the track never starts or gets stuck at 00:00. HTML5 is the default in *personal* builds; AVPlay remains an option.
- **Automatic next track.** Samsung HTML5 builds use the same audio element between tracks instead of swapping two elements at the end of a song.
- **Installs separately.** The personal app is called **Sonance AutoLogin** and does not replace the original Sonance3.
- **Two home-screen icons.** Pick a wide or a square one.

The rest is Sonance: artists, albums, playlists, synced lyrics, search, favourites, the playback queue, and remote-control navigation. All credit for that goes to the upstream project.

## Quick start

**Requirements:** macOS or Linux, Node.js 18+, bash, zip, unzip, perl, and internet for the first build. The upstream build uses npm/npx for minification.

~~~bash
git clone https://github.com/vbrekher/sonance3-autologin.git
cd sonance3-autologin
npm run build:personal
~~~

During setup you'll be asked for:

~~~text
Navidrome URL (include http:// or https://): https://music.example.com
Username: alex
Playback [H]TML5 / [A]VPlay (default H):
Password (hidden; paste is fine):
~~~

Paste the password normally. **Nothing is displayed while you type it.** The password prompt comes last.

The builder produces two files in `dist/`. They contain the same app, so **install only one**:

| Your WGT | Home-screen icon |
| --- | --- |
| `dist/Sonance-AutoLogin-Oblong.wgt` | Wide, 16:9 |
| `dist/Sonance-AutoLogin-Square.wgt` | Square |

Install it with [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung): enable Developer Mode on the TV, connect the TV and computer to the same network, then select the **custom WGT** file in Apps2Samsung. The installer can re-sign the package for your TV.

**New to Samsung sideloading?** Read the [step-by-step installation guide](docs/INSTALLATION.md) first. Windows users can see the experimental [WSL notes](docs/INSTALLATION.md#windows).

> **Private build = private password.** The generated WGT embeds your password, which anyone with the file can extract. Never share your personal WGT or upload it to GitHub Releases/Issues/Actions. Use a dedicated, limited-access Navidrome account for the TV. Read [Security](SECURITY.md).

## Which TVs work?

| TV | Audio mode | Result |
| --- | --- | --- |
| Samsung UE43DU7100UXUA, Tizen 9.0 | HTML5 Audio | **Confirmed on device:** sign-in, playback, and automatic next track |
| Other Samsung TVs supported by Sonance3 | HTML5 or AVPlay | Not independently verified by this fork |

Original Sonance3 targets Samsung Tizen 5.0+ (2019 or newer). The successful Tizen 9 test does **not** prove every model and codec will work. More details: [Compatibility](docs/COMPATIBILITY.md).

## Helpful links

| I want to… | Read |
| --- | --- |
| Build and install my personal WGT | [Installation](docs/INSTALLATION.md) |
| Follow instructions in Russian | [Русская инструкция](docs/README.ru.md) |
| Fix 00:00 playback, missing songs or installation errors | [Troubleshooting](docs/TROUBLESHOOTING.md) |
| Know whether a format / TV is supported | [Compatibility](docs/COMPATIBILITY.md) |
| Change my password or update the app | [FAQ](docs/FAQ.md) |
| Report a problem or contribute a fix | [Contributing](CONTRIBUTING.md) |
| Understand what the WGT contains | [Security](SECURITY.md) |

### A note on downloads

**There is no universal preconfigured WGT to download.** Each user needs to run the personal builder. The `Sonance3.wgt`, `Sonance3-Oblong.wgt` and Android APK in the repository are inherited **upstream builds**, not preconfigured AutoLogin releases. Do not expect them to log in automatically.

The repository currently has no tagged AutoLogin release. Use the source as documented here; see [Release policy](docs/RELEASING.md) for how future public releases will be handled.

## Development

~~~bash
npm run test:personal
node --test tests/html5-autonext.test.mjs
python3 tests/hidden-password-pty.py
~~~

The normal upstream `./build.sh` still builds generic Sonance packages. The personal builder works in a temporary copy of the app and does not write passwords into the tracked source files. The resulting private files live only in the ignored `dist/` directory.

## Thanks and license

Sonance3 and its interface were created by [MrSimmo](https://github.com/MrSimmo/sonance3) and its contributors. This project is an independent fork and is not affiliated with or endorsed by the original author. Please support the upstream project.

Distributed under [GNU GPL v3](LICENSE). If you redistribute modified packages, follow the license requirements, including making the corresponding source available.

