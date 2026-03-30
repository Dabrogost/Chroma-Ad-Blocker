const fs = require('fs');
const path = require('path');

const rulesDir = path.join(__dirname, '..', 'extension', 'rules');
const ruleFiles = fs.readdirSync(rulesDir).filter(file => file.startsWith('rules') && file.endsWith('.json'));

let currentGlobalId = 1;
let totalRulesProcessed = 0;

console.log('🚀 Starting Auto-Renumbering for MV3 Rules...\n');

ruleFiles.forEach(file => {
  const filePath = path.join(rulesDir, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ Warning: ${file} not found. Skipping.`);
    return;
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const rules = JSON.parse(fileContent);
    
    // Assign a guaranteed unique ID to every rule
    rules.forEach(rule => {
      rule.id = currentGlobalId++;
    });
    
    // Overwrite the file with the perfectly numbered rules
    fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf8');
    
    console.log(`✅ ${file}: Processed ${rules.length} rules. (IDs ended at ${currentGlobalId - 1})`);
    totalRulesProcessed += rules.length;
    
  } catch (error) {
    console.error(`❌ Error processing ${file}. Error:`, error.message);
  }
});

console.log(`\n🎉 SUCCESS: ${totalRulesProcessed} total rules perfectly renumbered!`);
console.log('You are completely safe from duplicate ID crashes.');