# Listny

Voice dictation for any app, in the style of Wispr Flow. Press a hotkey, speak, press it again, and the transcript is pasted where your cursor is.

Built with Electron + React. Speech-to-text runs on the cloud provider you choose:

| Provider   | Default model            |
| ---------- | ------------------------ |
| OpenAI     | `gpt-4o-mini-transcribe` |
| Groq       | `whisper-large-v3-turbo` |
| ElevenLabs | `scribe_v1`              |

An optional **AI cleanup** pass (OpenAI or Groq chat model) removes filler words, applies spoken self-corrections ("at 3, no, at 4") and fixes punctuation.

## Run

```bash
npm install
npm start
```

On first launch the settings window opens. Add an API key for at least one provider. Listny then lives in the menu bar.

- **Alt+Space** (configurable): start or stop dictating
- **Esc**: cancel while recording
- To paste automatically, macOS needs **Accessibility** permission (System Settings → Privacy & Security → Accessibility). Without it, the text is copied to the clipboard instead.

## How it works

- `electron/main.cjs`: tray, global hotkey, recording-pill window (a non-activating panel, so focus stays in your app), and the pipeline: transcribe → clean up → paste → save to history
- `electron/transcribe.cjs`: provider calls (OpenAI, Groq, ElevenLabs) and the cleanup prompt
- `electron/paste.cjs`: puts the text on the clipboard, sends ⌘V, then restores your previous clipboard
- `electron/settings.cjs`: settings and history saved as JSON in `userData`; API keys encrypted with `safeStorage`
- `src/pill.jsx`: records the mic as WebM/Opus and shows a live level meter
- `src/hub.jsx`: history and settings

## Limitations

- The hotkey toggles recording on and off. Electron's `globalShortcut` can't detect key release, so there's no hold-to-talk yet.
- Audio is uploaded after you stop. There's no streaming transcription.
