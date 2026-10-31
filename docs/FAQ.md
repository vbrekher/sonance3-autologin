# Frequently asked questions

### Do I need Navidrome on Bunny?

No. Navidrome can be at home, on a VPS or any other hosting provider. Give the builder the URL that your Samsung TV can reach.

### Do I need to type the password on the TV?

No. You'll enter it only when running the builder on your computer. It is then included in your personal WGT.

### Can I download a ready-to-use WGT?

Not one with your account information. **You must generate your own.** The upstream Sonance3 WGT files in the repository are not personalized.

### Is the password safe?

The password doesn't go to GitHub, but it **can be extracted from your private WGT** and is stored by the app locally. Don't distribute the package. Consider making a separate Navidrome TV account.

### Can I change servers later?

Yes: rebuild and reinstall with the new URL and password. Because the configuration is embedded, the app restores those values on launch.

### Can I keep the original Sonance3 installed?

Yes. This fork gives the personalized app a different Tizen app ID.

### What is HTML5 Audio? Should I choose it?

HTML5 is an alternative playback engine. It fixed playback on a Samsung UE43DU7100UXUA where the original AVPlay stayed at 00:00. It's the default for personal builds. AVPlay is still available if you prefer it or if a format is unsupported through HTML5.

### Does the next song play automatically?

Yes in the verified Tizen 9 HTML5 setup. A prior two-element gapless implementation could stop at the end of a track; the Samsung-specific implementation now keeps the active element when moving to the next song.

### Is playback truly gapless?

Don't assume so. The Samsung HTML5 workaround prioritizes reliable automatic next-track playback over gapless transitions. Tiny gaps between songs may remain.

### Can I use Jellyfin?

The original Sonance3 supports Jellyfin. The **personal auto-login builder currently supports password-based Navidrome/Subsonic servers only**. Jellyfin auto-login isn't implemented yet.

### Does this work on Android TV?

The upstream repository includes an Android TV app, but this project's personal build script currently produces **Samsung Tizen WGT** files only.

### Can I build on Windows?

There's no native Windows builder yet. WSL2 may work; see [installation notes](INSTALLATION.md#windows). We haven't verified it end-to-end.

### Is this the official Sonance3?

No. Sonance AutoLogin is an independent community fork. Please credit and support [MrSimmo's original project](https://github.com/MrSimmo/sonance3).
