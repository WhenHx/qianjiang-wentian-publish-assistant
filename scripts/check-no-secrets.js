const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const forbidden = [
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /service[_-]?role[_-]?key\s*[:=]\s*[^\s`"']+/i,
  /supabase[^\n]{0,80}(service[_-]?role|secret)[^\n]{0,40}[:=]\s*[^\s`"']+/i
];
const allow = [/sim-user-[ab]-token/, /insecure-dev:/];
let failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', 'runtime', '.git'].includes(entry)) continue;
    if (entry === 'check-no-secrets.js') continue;
    const file = path.join(dir, entry);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(js|json|md|ps1|cmd|html|css|ya?ml|txt)$/i.test(entry)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        const match = text.match(pattern);
        if (match && !allow.some(item => item.test(match[0]))) failures.push(`${path.relative(root, file)}: ${pattern}`);
      }
    }
  }
}
walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('NO_FORBIDDEN_SECRETS_FOUND');
