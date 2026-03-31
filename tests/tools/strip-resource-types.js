const fs = require('fs');
const path = require('path');

const rulesDir = path.join(__dirname, '..', '..', 'extension', 'rules');
const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));

// Only strip when all 11 OISD catch-all resource types are present.
// Rules with a deliberate subset (e.g. script+xmlhttprequest only) are left untouched.
const CATCHALL = new Set([
  'main_frame', 'sub_frame', 'script', 'image', 'stylesheet',
  'object', 'xmlhttprequest', 'ping', 'media', 'font', 'other'
]);

function isCatchAll(resourceTypes) {
  if (!resourceTypes || resourceTypes.length !== CATCHALL.size) return false;
  return resourceTypes.every(t => CATCHALL.has(t));
}

console.log('🔧 Stripping catch-all resourceTypes from static rules...\n');

let totalRules = 0;
let totalModified = 0;
let totalSkipped = 0;

ruleFiles.forEach(file => {
  const filePath = path.join(rulesDir, file);
  const rules = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  let modified = 0;
  let skipped = 0;
  rules.forEach(rule => {
    if (rule.condition && rule.condition.resourceTypes) {
      if (isCatchAll(rule.condition.resourceTypes)) {
        delete rule.condition.resourceTypes;
        modified++;
      } else {
        skipped++;
      }
    }
  });

  fs.writeFileSync(filePath, JSON.stringify(rules), 'utf8');
  console.log(`✅ ${file}: ${modified} stripped, ${skipped} intentional rules preserved.`);
  totalRules += rules.length;
  totalModified += modified;
  totalSkipped += skipped;
});

console.log(`\n🎉 Done. ${totalModified} stripped, ${totalSkipped} preserved across ${ruleFiles.length} files.`);