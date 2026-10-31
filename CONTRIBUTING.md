# Contributing to Sonance AutoLogin

Thanks for taking the time. This is a small community fork of [MrSimmo's Sonance3](https://github.com/MrSimmo/sonance3). The goal is straightforward: make personal Samsung TV installs easier and fix TV-specific playback quirks without breaking the upstream player.

## Before opening an issue

Check [Troubleshooting](docs/TROUBLESHOOTING.md) and [Compatibility](docs/COMPATIBILITY.md). If it's still broken, please include the TV model, Tizen version, backend, media format, exact steps and what you expected.

**Never attach a personal WGT or a URL containing Subsonic authentication parameters.** See [Security](SECURITY.md).

## Sending a pull request

1. Fork this repository and create a branch for one change.
2. Avoid unrelated reformatting of upstream Sonance files.
3. Run the personal-builder tests and any relevant existing tests.
4. Describe what changed, why, and which TV or browser you tested.
5. For anything in the WGT builder, check that no credentials or personal WGT files are committed.

~~~bash
npm run test:personal
node --test tests/html5-autonext.test.mjs
python3 tests/hidden-password-pty.py
~~~

Playwright coverage is available in the upstream project, but a full browser run may take longer. If you didn't run it, say so.

## Changes to upstream code

Keep fixes narrowly scoped where possible. If a playback fix also helps the original Sonance3, consider opening a corresponding PR upstream, with proper credit and reproduction steps.

## Release rules

Don't upload a WGT built with a real account. Public releases should contain source and build instructions; personal binaries must remain on users' machines.

This project follows the [GNU GPL v3](LICENSE) terms of the original Sonance3. Keep original notices and credit the upstream author.
