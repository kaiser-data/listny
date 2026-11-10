# Changelog

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
