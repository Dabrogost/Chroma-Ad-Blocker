const fs = require('fs');

// Target the last bulk file
const filePath = './rules_10.json';
const rules = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Chop exactly 58 rules off the end of the array
rules.splice(-58);

// Overwrite the file with proper formatting
fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf8');

console.log('✂️ Successfully trimmed the last 58 rules from rules_10.json!');