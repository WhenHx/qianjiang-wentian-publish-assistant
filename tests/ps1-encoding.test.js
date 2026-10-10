const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 含中文的 PowerShell 脚本必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 按 GBK 解析导致语法错误
test('含中文的 .ps1 脚本必须带 UTF-8 BOM', () => {
  const files = [
    'apps/desktop-wpf/Assistant.ps1',
    'scripts/package.ps1',
    'scripts/screenshot-tabs.ps1'
  ];
  for (const file of files) {
    const buf = fs.readFileSync(path.resolve(file));
    const text = buf.toString('utf8');
    // eslint-disable-next-line no-control-regex
    const hasChinese = /[一-鿿]/.test(text);
    if (!hasChinese) continue;
    assert.ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, `${file} 缺少 UTF-8 BOM`);
  }
});
