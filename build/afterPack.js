// Ad-hoc code-sign the macOS .app after packing.
//
// We have no paid Apple Developer ID, so this does NOT remove the "unidentified
// developer" prompt on first launch (only notarization does). But an ad-hoc
// signature makes the unsigned build actually launchable — especially on Apple
// Silicon, where a fully unsigned app is killed as "damaged" instead of showing
// the bypassable prompt. Best-effort: never fail the build over it.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  // For universal builds electron-builder packs x64 and arm64 into "*-temp"
  // dirs and then MERGES them; signing those intermediate apps breaks the merge.
  // Only touch the final merged app (or a plain single-arch build).
  if (context.appOutDir.indexOf('-temp') !== -1) return;
  const name = (context.packager.appInfo && context.packager.appInfo.productFilename) || 'fabu';
  const appPath = path.join(context.appOutDir, name + '.app');
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'ignore' });
    console.log('afterPack: ad-hoc signed ' + appPath);
  } catch (e) {
    console.log('afterPack: ad-hoc sign skipped (' + (e && e.message) + ')');
  }
};
