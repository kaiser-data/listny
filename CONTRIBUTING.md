# Contributing to Listny

Thanks for helping. Listny is small on purpose: about 1,300 lines, no runtime dependencies. Changes that keep it that way are the easiest to merge.

## Set up

```bash
npm install
npm start        # build the UI and run the app
npm run check    # syntax check, unit tests, UI build: run this before a pull request
```

You need macOS and Node 22 or later. Only one Listny can run at a time, so quit the installed app before `npm start`.

## Where things are

The README has a [repo layout](README.md#repo-layout). In short: `electron/` is the main process, `src/` is the two React pages, `test/` holds the unit tests.

## Guidelines

- **One change per pull request**, with a short description of what you tested by hand. Dictation touches the microphone, the clipboard and other apps, so say which app you pasted into.
- **Add a test** when you change `electron/transcribe.cjs` or other logic that runs without Electron.
- **No new runtime dependencies** without a good reason. Prefer a few lines of code over a package.
- **Never log or store** dictated text or key material outside the existing history and keychain paths.
- **Comments** explain why, not what.

## Reporting bugs

Open an issue with the lines of `~/Library/Logs/listny/main.log` around the failure. The log has no dictated text and no keys, but read it before posting.

## Security

Please report security problems privately through GitHub's "Report a vulnerability" on the repository's Security tab, not in a public issue.
