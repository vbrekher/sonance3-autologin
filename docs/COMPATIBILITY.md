# Compatibility notes

## Tested by this fork

| Device | Tizen | Mode | What was checked | Status |
| --- | --- | --- | --- | --- |
| Samsung UE43DU7100UXUA | 9.0 | HTML5 Audio | Personal autologin, playback, hidden password prompt at build, automatic next song | **User-verified** |

This result was reported after installation and playback on a real TV. It isn't a blanket certification for all Tizen 9 devices, audio codecs or networks.

## Upstream support

Original [Sonance3](https://github.com/MrSimmo/sonance3) targets Samsung Smart TVs running Tizen 5.0 or later (roughly 2019 onward). Its native AVPlay implementation remains available. This fork hasn't independently reproduced upstream's full device matrix.

## Formats

Sonance3 supports common music formats with native or server-side playback/transcoding as appropriate. But Samsung HTML5 support varies by TV and firmware. For reliable comparisons, start with an MP3 that is known to play in the built-in Samsung browser, then test FLAC/AAC/Opus separately.

If the chosen format isn't supported by HTML5, try AVPlay or check your Navidrome transcoding setup. Don't interpret a successful library listing as proof that the audio stream or codec is supported.

## Send us a compatibility report

Please use the [bug/compatibility template](../.github/ISSUE_TEMPLATE/bug_report.md) with:

- Samsung model and Tizen version
- Playback engine selected at build time
- Format tested, for example MP3 or FLAC
- Whether the same song plays in the Samsung browser
- Whether the next song plays automatically

Do **not** send your private WGT or authenticated stream URLs.
