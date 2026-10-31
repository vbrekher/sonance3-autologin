# Troubleshooting

These are the issues we've actually encountered or expect from the build/installation process. If yours isn't here, [open a bug report](https://github.com/vbrekher/sonance3-autologin/issues/new/choose) and remove all passwords and stream tokens first.

## The library shows up, but songs stay at 00:00

The original Samsung AVPlay backend failed this way on a UE43DU7100UXUA with Tizen 9.0. The same song worked in the TV browser, and switching to HTML5 Audio made playback work.

**What to try:** build again and press Enter at the playback choice to keep **HTML5**. If the same song does not play in the Samsung browser either, the cause may be the media URL, codec, or server delivery rather than AVPlay.

This is not proof that every AVPlay problem has the same cause.

## One song ends and the next one doesn't start

An earlier HTML5 build could try to switch between two audio elements at the track boundary. The Samsung HTML5 build now continues playback using the same element. Make sure your local source is up to date and build a fresh WGT. This was verified on the Tizen 9 test TV.

~~~bash
git pull --ff-only
npm run build:personal
~~~

## My server address is rejected

Use a complete URL, including `http://` or `https://`. Examples:

- `https://music.example.com`
- `http://192.168.1.20:4533`

Don't put the username, password, query parameters or fragments in the URL. The script asks for credentials separately. Make sure the URL is reachable from the TV's network.

## The terminal doesn't show the password while I type

That's intentional. The script disables terminal echo for the password prompt. Paste your password and press Enter. If the prompt is missing or the password **is visible**, stop, update the source, and open an issue (without posting the password).

## It says "Username and password cannot be empty"

Check that you've filled in the user field and pasted the password at the final password prompt. If your password manager did not paste into the terminal, try pasting again. Avoid making screenshots with a visible password.

## The build fails because a command isn't found

- `node` / `npm`: install Node.js 18 or newer.
- `zip`, `unzip` or `perl`: install these using your operating system's package manager.
- `npx` / minifier download: check that npm works and that you have an internet connection. Sonance's upstream build uses npm tools for minification.

## Apps2Samsung can't find the TV or install the WGT

1. Confirm TV and computer are on the same network.
2. Ensure the TV is in Developer Mode with the installing computer's IP.
3. Restart the TV after enabling Developer Mode.
4. Let Apps2Samsung re-sign the WGT and follow its certificate setup.
5. If discovery fails, enter the TV IP manually.

See the [Samsung device guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html) and [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung).

## It works on my computer but not on Samsung

Computer browsers and Tizen use different media engines. Test the same song in Samsung's built-in browser. When asking for help, include your TV model, Tizen version, chosen backend (HTML5/AVPlay), audio format and what happens. Do not share authenticated stream URLs.

## Some songs work and others don't

That can be a codec or source-file issue. Test an MP3 as a baseline and compare the same problem track in the TV browser. HTML5 doesn't support every format on every TV; AVPlay may work better for some codecs.

## I changed my Navidrome password

Rebuild the personal WGT with the new password, then reinstall it. The bundled credentials are restored each time the personal app starts. Old WGT files containing the old password should be securely deleted.

## Can I send you the WGT to debug?

**No, not a personal build.** It contains your password. Share a redacted log, model/Tizen version, and reproduction steps instead. Never publish URLs containing Subsonic `u`, `t`, `s`, `p` or other authentication fields.
