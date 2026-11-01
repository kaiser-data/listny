// electron-builder afterPack hook: signs Listny.app before the DMG/zip are made.
// Uses a stable local identity when one exists, so macOS keeps the microphone and
// Accessibility permissions across rebuilds; otherwise falls back to ad-hoc signing.
// Set LISTNY_SIGN_IDENTITY to choose a different certificate.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const PREFERRED = process.env.LISTNY_SIGN_IDENTITY || 'mac-dictate local signing';

function pickIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    if (out.includes(`"${PREFERRED}"`)) return PREFERRED;
  } catch {}
  return '-';
}

exports.default = async function sign({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  let identity = pickIdentity();
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'pipe' });
  } catch (err) {
    // e.g. errSecInternalComponent when the keychain won't release the key without a prompt
    console.warn(`  • could not sign with "${identity}" (${String(err.stderr).trim().split('\n').pop()}), using ad-hoc`);
    identity = '-';
    execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'pipe' });
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed Listny.app with ${identity === '-' ? 'an ad-hoc signature' : `"${identity}"`}`);
};
