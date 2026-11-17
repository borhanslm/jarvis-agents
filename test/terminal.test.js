// Install/sign-in windows: the launcher asks Windows for a real new console (Start-Process),
// and the command survives any quotes or pipes because it travels base64-encoded.
const test = require('node:test');
const assert = require('node:assert');
const { terminalLauncher } = require('../lib/setup');

test('terminal launcher: PowerShell command is encoded intact, cmd command is quoted safely', () => {
  const cmd = `Write-Host "it's ok"; irm https://example.test/install.ps1 | iex`;
  const ps = terminalLauncher(cmd);
  assert.match(ps, /^Start-Process powershell\.exe -ArgumentList '-NoExit',/);
  const enc = ps.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), cmd);
  assert.equal(terminalLauncher(`echo it's && exit`, 'cmd'), `Start-Process cmd.exe -ArgumentList '/k echo it''s && exit'`);
});
