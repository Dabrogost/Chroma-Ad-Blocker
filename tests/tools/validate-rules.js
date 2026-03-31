const fs = require('fs');
const path = require('path');

const rulesDir = path.join(__dirname, '..', '..', 'extension', 'rules');
const ruleFiles = fs.readdirSync(rulesDir).filter(file => file.startsWith('rules') && file.endsWith('.json'));

let totalRules = 0;
const idMap = new Map();
const duplicates = [];

console.log('🔍 Starting Manifest V3 Rule Validation...\n');

ruleFiles.forEach(file => {
  const filePath = path.join(rulesDir, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ Warning: ${file} not found in directory. Skipping.`);
    return;
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const rules = JSON.parse(fileContent);
    
    totalRules += rules.length;

    rules.forEach(rule => {
      // Manifest V3 requires an 'id' for every rule
      if (!rule.id) {
         console.warn(`⚠️ Warning: Found a rule missing an ID in ${file}`);
         return;
      }

      if (idMap.has(rule.id)) {
        duplicates.push({
          id: rule.id,
          files: [idMap.get(rule.id), file]
        });
      } else {
        idMap.set(rule.id, file);
      }
    });
    
    console.log(`✅ ${file}: ${rules.length} rules loaded.`);
  } catch (error) {
    console.error(`❌ Error parsing ${file}. Make sure it is valid JSON. Error:`, error.message);
  }
});

console.log('\n📊 --- Validation Summary ---');
// MV3 allows up to 300,000 global rules, and up to 100,000 dynamic rules. 
// Static rules (like these) share that 300k limit.
console.log(`Total Rules Parsed: ${totalRules} / 300,000 (MV3 Global Limit)`);

if (duplicates.length > 0) {
  console.error(`\n🚨 CRITICAL ERROR: Found ${duplicates.length} duplicate IDs!`);
  // Print up to the first 15 duplicates so we don't flood the terminal
  duplicates.slice(0, 15).forEach(dup => {
    console.error(`   - ID ${dup.id} exists in both ${dup.files[0]} and ${dup.files[1]}`);
  });
  if (duplicates.length > 15) {
      console.error(`   ... and ${duplicates.length - 15} more.`);
  }
  console.log('\nFix these duplicates before loading the extension in Chrome.');
} else {
  console.log('\n🎉 SUCCESS: All rule IDs are completely unique. You are good to go!');
}