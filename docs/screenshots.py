"""Regenerates the README screenshots from the real UI with demo data.

The built pages in dist/ are opened in headless Chrome with a stand-in for the
window.listny bridge, so no real settings, history or keys are involved.

Usage: npm run build && python3 docs/screenshots.py dist <out-dir> <speech.wav>
Needs the Python package "playwright" and Google Chrome. The WAV file is played
into the fake microphone so the level meter moves (make one with `say -o`).
Writes history.png, settings.png and pill0..5.png (pick one for docs/img/pill.png).
"""
import sys, json, subprocess, time, datetime
from playwright.sync_api import sync_playwright
dist, out = sys.argv[1], sys.argv[2]
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', dist], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
now = datetime.datetime(2026, 11, 10, 14, 30)
def at(mins): return (now - datetime.timedelta(minutes=mins)).isoformat()
history = [
 dict(id='d1', at=at(2), provider='groq', result='pasted', latencyMs=820, durationMs=9000, raw='', text="Sounds good, let's meet on Thursday at four. I'll bring the slides and send the agenda tonight."),
 dict(id='d2', at=at(11), provider='groq', result='pasted', latencyMs=1140, durationMs=21000, raw='', text="Please refactor the settings module so the cache is invalidated when the file changes on disk, and add a test for it."),
 dict(id='d3', at=at(26), provider='elevenlabs', result='failed', durationMs=14000, raw='', text='', audioFile='d3.webm', error='elevenlabs transcription failed (401): quota_exceeded. You have 0 credits remaining.'),
 dict(id='d4', at=at(48), provider='elevenlabs', result='pasted', latencyMs=1310, durationMs=17000, raw='', text="Hallo zusammen, kurze Erinnerung: Das Treffen beginnt morgen um neun Uhr im großen Raum."),
 dict(id='d5', at=at(95), provider='openai', result='copied', latencyMs=990, durationMs=6000, raw='', text="Remind me to renew the domain before the end of the month."),
]
settings = dict(hotkey='Alt+Space', language='', stt=dict(provider='groq', models=dict(openai='gpt-4o-mini-transcribe', groq='whisper-large-v3-turbo', elevenlabs='scribe_v1')),
 cleanup=dict(enabled=True, provider='groq', models=dict(openai='gpt-4.1-mini', groq='llama-3.3-70b-versatile')),
 pasteIntoActiveApp=True, restoreClipboard=True, muteWhileDictating=True, launchAtLogin=True, canLaunchAtLogin=True, hotkeyError='',
 hasKey=dict(openai=False, groq=True, elevenlabs=True), keySlots={'openai': False, 'openai:backup': False, 'groq': True, 'groq:backup': False, 'elevenlabs': True, 'elevenlabs:backup': True})
stub = """
const S = %s, H = %s; const off = () => () => {};
window.__start = null;
window.listny = {
  getSettings: async () => S, saveSettings: async (p) => Object.assign(S, p), onSettingsChanged: off, captureHotkey() {},
  setKey: async () => S, getHistory: async () => H, clearHistory: async () => {}, retry: async () => {}, copy: async () => {}, onHistoryChanged: off,
  onStart: (fn) => { window.__start = fn; return () => {}; }, onStop: off, onCancel: off, pillReady() {}, processAudio: async () => ({status:'pasted'}), recordingFailed(m) { window.__err = m; }, discardRecording() {},
};""" % (json.dumps(settings), json.dumps(history))
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + sys.argv[3], '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport=dict(width=760, height=640), device_scale_factor=2, color_scheme='dark', locale='en-US', timezone_id='Europe/Berlin', permissions=['microphone'])
    ctx.add_init_script(stub)
    pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8765/hub.html'); pg.wait_for_selector('.history li')
    pg.screenshot(path=f'{out}/history.png')
    pg.click('nav button:has-text("Settings")'); pg.wait_for_selector('.key-row')
    pg.screenshot(path=f'{out}/settings.png', full_page=True)
    pill = ctx.new_page(); pill.set_viewport_size(dict(width=260, height=64))
    pill.goto('http://127.0.0.1:8765/pill.html'); pill.wait_for_function('window.__start')
    pill.evaluate('window.__start()'); pill.wait_for_timeout(3000)
    for i in range(6):
        pill.wait_for_timeout(170)
        pill.screenshot(path=f'{out}/pill{i}.png', omit_background=True)
    print('errors:', errs, pill.evaluate('window.__err || null'))
    b.close()
srv.terminate()
