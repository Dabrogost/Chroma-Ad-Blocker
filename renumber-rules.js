const fs = require('fs');
const path = require('path');

// All 11 of your rule files
const ruleFiles = [
  'rules.json',
  'rules_1.json',
  'rules_2.json',
  'rules_3.json',
  'rules_4.json',
  'rules_5.json',
  'rules_6.json',
  'rules_7.json',
  'rules_8.json',
  'rules_9.json',
  'rules_10.json'
];

let currentGlobalId = 1;
let totalRulesProcessed = 0;

console.log('🚀 Starting Auto-Renumbering for MV3 Rules...\n');

ruleFiles.forEach(file => {
  const filePath = path.join(__dirname, file);
  
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