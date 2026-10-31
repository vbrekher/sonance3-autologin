# Security

## Read this before building

**Your personal WGT contains your Navidrome password.** This project deliberately puts connection details into a local application package so that you don't have to enter them with a Samsung remote. Packaging is not encryption. Anyone who gets a copy of the WGT can inspect the embedded JavaScript and recover the credentials.

The installed app also stores the account details in the TV's local storage, as Sonance3 does.

### What the builder does

- Asks for your own server URL, username and password on your computer.
- Hides the password when pasting it in a terminal.
- Builds WGT files locally, under the Git-ignored `dist/` directory.
- Does not send your credentials to this project's GitHub or to its maintainers.

The upstream build may use npm/npx to download tooling; that is separate from transmitting your Navidrome credentials, which are not passed as npm arguments. The WGT still calls your music server when installed.

### What you should do

- Use a separate Navidrome account for the TV, preferably with limited permissions.
- Use HTTPS when accessing a remote server.
- Never upload personal WGT files to GitHub, Releases, Issues, CI artifacts, file sharing, or support tickets.
- Never attach authenticated media URLs or server logs containing Subsonic tokens.
- Change the password if your WGT or an authenticated stream URL has leaked.
- Rebuild the WGT after changing credentials and reinstall it.
- If you used an older builder that echoed your password, clear terminal scrollback and rotate any credential that was shared or captured.

**Do not publish a ready-made AutoLogin WGT with your own credentials.** Public releases should contain only source and reusable build tooling, unless a generic, credential-free binary is explicitly identified as such.

## Reporting a vulnerability

Please do not post real passwords, tokens, personal WGT files or authentication URLs in a public issue. Open an issue with a sanitized reproduction that contains no secrets, or contact the repository maintainer through GitHub using a private security-reporting channel if one is enabled.

We cannot promise a response time or an unsupported private contact method. If a live credential is involved, rotate it first.

## License

This fork is based on Sonance3 and remains licensed under GNU GPL v3. See [LICENSE](LICENSE).
