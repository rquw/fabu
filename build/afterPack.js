// ad-hoc sign the mac app. without this apple silicon kills it as damaged.
// does not stop the unidentified developer prompt, only notarizing does.
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
