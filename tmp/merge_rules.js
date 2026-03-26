const fs = require('fs');
const path = require('path');

const rulesPath = 'c:/Users/kerns/Documents/A.) JS Projects/yt-adblocker/rules/rules_9.json';
const fragmentPath = 'C:/Users/kerns/Documents/A.) JS Projects/yt-adblocker/tmp/rules_fragment.json';

try {
  let rulesContent = fs.readFileSync(rulesPath, 'utf8');
  if (rulesContent.charCodeAt(0) === 0xFEFF) rulesContent = rulesContent.slice(1);
  const rules = JSON.parse(rulesContent);

  let fragmentContent = fs.readFileSync(fragmentPath, 'utf8');
  if (fragmentContent.charCodeAt(0) === 0xFEFF) fragmentContent = fragmentContent.slice(1);
  const fragment = JSON.parse(fragmentContent);
  
  const updatedRules = rules.concat(fragment);
  
  fs.writeFileSync(rulesPath, JSON.stringify(updatedRules, null, 2), 'utf8');
  console.log(`Successfully merged ${fragment.length} rules. Total rules: ${updatedRules.length}`);
} catch (error) {
  console.error('Merge failed:', error.message);
  process.exit(1);
}

