# Public release checklist

This repository's current personal builder works from source. **Do not confuse a source update or green CI job with a publicly certified WGT release.**

Before publishing a tagged AutoLogin release:

1. Check source tests and build a fresh personal WGT locally.
2. Confirm installed app identity is separate from upstream Sonance3.
3. Validate login, at least two consecutive tracks, and manual Next/Previous on a real Samsung TV.
4. Check the README, installation instructions, supported TV claims and license.
5. Confirm no real passwords, personal server URL, Subsonic auth tokens, certificates or private WGT files were committed.
6. **Do not attach a personal WGT to Releases.** A reusable generic binary is allowed only if it contains absolutely no credentials, and is labeled clearly.
7. Keep a corresponding-source archive and GPL license / attribution with any redistributed executable.
8. Publish a factual changelog and known limitations: HTML5 is not guaranteed to be gapless or to support every codec.

For now, the original `Sonance3*.wgt` and `Sonance3-AndroidTV.apk` committed upstream are inherited artifacts. They are **not** Sonance AutoLogin releases and should not be advertised as preconfigured packages.
