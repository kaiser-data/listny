import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STT_PROVIDERS = [
  { id: 'openai', label: 'OpenAI', hint: 'gpt-4o-mini-transcribe, gpt-4o-transcribe, whisper-1' },
  { id: 'groq', label: 'Groq', hint: 'whisper-large-v3-turbo, whisper-large-v3' },
  { id: 'elevenlabs', label: 'ElevenLabs', hint: 'scribe_v1' },
];
const CLEANUP_PROVIDERS = STT_PROVIDERS.filter((p) => p.id !== 'elevenlabs');

// Converts a keydown event into an Electron accelerator string such as "Alt+Space".
function toAccelerator(e) {
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  const key = e.code === 'Space' ? 'Space' : e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
  return mods.length ? [...mods, key].join('+') : null;
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KeyField({ provider, label, isSet, onSaved }) {
  const [value, setValue] = useState('');
  const save = async (v) => {
    onSaved(await window.listny.setKey(provider, v));
    setValue('');
  };
  return (
    <div className="key-row">
      <span className="key-label">{label}</span>
      <input type="password" placeholder={isSet ? '•••••••• saved' : 'Paste API key'} value={value} onChange={(e) => setValue(e.target.value)} />
      <button disabled={!value.trim()} onClick={() => save(value)}>
        Save
      </button>
      {isSet && (
        <button className="ghost" onClick={() => save('')}>
          Remove
        </button>
      )}
    </div>
  );
}

function Settings({ settings, setSettings }) {
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const save = async (patch) => setSettings(await window.listny.saveSettings(patch));
  const stt = settings.stt.provider;
  const cp = settings.cleanup.provider;

  return (
    <div className="settings">
      <section>
        <h2>Shortcut</h2>
        <p className="muted">Press once to start dictating, again to paste. Esc cancels.</p>
        <button
          className={`hotkey ${recordingHotkey ? 'listening' : ''}`}
          onClick={() => setRecordingHotkey(true)}
          onBlur={() => setRecordingHotkey(false)}
          onKeyDown={(e) => {
            if (!recordingHotkey) return;
            e.preventDefault();
            if (e.key === 'Escape') return setRecordingHotkey(false);
            const acc = toAccelerator(e);
            if (acc) {
              setRecordingHotkey(false);
              save({ hotkey: acc });
            }
          }}
        >
          {recordingHotkey ? 'Press a key combination…' : settings.hotkey}
        </button>
        {settings.hotkeyError && <p className="error">{settings.hotkeyError}</p>}
      </section>

      <section>
        <h2>Transcription</h2>
        <Segmented options={STT_PROVIDERS} value={stt} onChange={(id) => save({ stt: { provider: id } })} />
        <label className="field">
          Model
          <input
            key={stt}
            defaultValue={settings.stt.models[stt]}
            onBlur={(e) => save({ stt: { models: { [stt]: e.target.value.trim() } } })}
          />
          <small className="muted">{STT_PROVIDERS.find((p) => p.id === stt).hint}</small>
        </label>
        <label className="field">
          Language
          <input defaultValue={settings.language} placeholder="Auto-detect (or e.g. en, de)" onBlur={(e) => save({ language: e.target.value.trim() })} />
        </label>
        {!settings.hasKey[stt] && <p className="error">Add a {STT_PROVIDERS.find((p) => p.id === stt).label} API key below.</p>}
      </section>

      <section>
        <h2>AI cleanup</h2>
        <label className="toggle">
          <input type="checkbox" checked={settings.cleanup.enabled} onChange={(e) => save({ cleanup: { enabled: e.target.checked } })} />
          Remove filler words, apply self-corrections, fix punctuation
        </label>
        {settings.cleanup.enabled && (
          <>
            <Segmented options={CLEANUP_PROVIDERS} value={cp} onChange={(id) => save({ cleanup: { provider: id } })} />
            <label className="field">
              Model
              <input
                key={cp}
                defaultValue={settings.cleanup.models[cp]}
                onBlur={(e) => save({ cleanup: { models: { [cp]: e.target.value.trim() } } })}
              />
            </label>
          </>
        )}
      </section>

      <section>
        <h2>Output</h2>
        <label className="toggle">
          <input type="checkbox" checked={settings.pasteIntoActiveApp} onChange={(e) => save({ pasteIntoActiveApp: e.target.checked })} />
          Paste into the active app (needs Accessibility permission)
        </label>
        <label className="toggle">
          <input type="checkbox" checked={settings.restoreClipboard} onChange={(e) => save({ restoreClipboard: e.target.checked })} />
          Restore my clipboard after pasting
        </label>
      </section>

      <section>
        <h2>API keys</h2>
        <p className="muted">Stored encrypted in your macOS keychain. Audio goes straight from this Mac to the provider you pick.</p>
        {STT_PROVIDERS.map((p) => (
          <KeyField key={p.id} provider={p.id} label={p.label} isSet={settings.hasKey[p.id]} onSaved={(s) => setSettings({ ...settings, ...s })} />
        ))}
      </section>
    </div>
  );
}

function History() {
  const [items, setItems] = useState([]);
  const [copied, setCopied] = useState(null);
  const load = () => window.listny.getHistory().then(setItems);
  useEffect(() => {
    load();
    return window.listny.onHistoryChanged(load);
  }, []);

  if (!items.length) {
    return (
      <div className="empty">
        <p>Nothing dictated yet.</p>
        <p className="muted">Put your cursor in any text field and press your shortcut.</p>
      </div>
    );
  }
  const words = items.reduce((n, i) => n + i.text.split(/\s+/).filter(Boolean).length, 0);
  return (
    <div className="history">
      <div className="history-head">
        <span className="muted">
          {items.length} dictations · {words.toLocaleString()} words
        </span>
        <button className="ghost" onClick={() => window.listny.clearHistory().then(load)}>
          Clear
        </button>
      </div>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <p>{i.text}</p>
            <div className="meta">
              <span>{new Date(i.at).toLocaleString()}</span>
              <span>{i.provider}</span>
              <span>{(i.latencyMs / 1000).toFixed(1)}s</span>
              <button
                className="ghost"
                onClick={() => {
                  window.listny.copy(i.text);
                  setCopied(i.id);
                }}
              >
                {copied === i.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Hub() {
  const [tab, setTab] = useState('history');
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    window.listny.getSettings().then((s) => {
      setSettings(s);
      if (!Object.values(s.hasKey).some(Boolean)) setTab('settings');
    });
  }, []);
  if (!settings) return null;

  return (
    <div className="hub">
      <header>
        <h1>Listny</h1>
        <nav>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
            History
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
      </header>
      <main>{tab === 'history' ? <History /> : <Settings settings={settings} setSettings={setSettings} />}</main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Hub />);
