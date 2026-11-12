# Changelog

## Unreleased

- **Live dictation with ElevenLabs:** audio is streamed to the realtime model `scribe_v3_live`. Words appear above the pill as you speak, and each finished sentence is typed into the focused field at your pause. Falls back to the whole recording if the stream fails.
- **Typing as keystrokes:** live text is typed character by character instead of pasted, so the clipboard is left alone. Paste stays as the fallback.
- **Listening indicator:** the pill's dot stays grey until the microphone actually delivers sound and turns red when it is listening.
- **Faster start:** API keys are decrypted in the background, so the hotkey works right after launch instead of after up to a minute.
- **Rests & Lyrics** (on by default): the dictation is cut at your pauses and each piece is transcribed while you keep talking. The text so far shows above the pill, the wait after stopping no longer grows with the length of the dictation, and long pauses are not uploaded. Falls back to the whole recording if any piece fails.
- **Live typing:** with Rests on, each piece is typed into the focused text field as soon as it is transcribed, and your clipboard is restored afterwards.

## 0.2.0 (2026-11-10)

- Backup API key per provider. When the main key is out of credits or rejected, the dictation is retried with the backup key, and the key that worked is remembered across restarts.
- Paste is sent as a direct key event instead of through System Events, which could lose the keystroke after a long dictation.
- Fixed a freeze when the hotkey was pressed before the recording pill had loaded after launch.
- A dictation that hangs is reset automatically instead of leaving the hotkey dead.
- Log file at `~/Library/Logs/listny/main.log` (no dictated text, no keys).
- A failed key save now shows the error in the settings window.
- Keys can be imported at launch from `LISTNY_KEY_<PROVIDER>` environment variables.
- Unit tests for the transcription module, CI, and a release workflow that builds Apple Silicon and Intel DMGs.

## 0.1.0 (2026-11-01)

- First packaged macOS app: hotkey dictation with OpenAI, Groq or ElevenLabs, optional AI cleanup, history, mute while dictating, retry of failed dictations.
