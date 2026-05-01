const fs = require('fs');
const path = require('path');

const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter(file => file.endsWith('.test.js'))
  .sort();

for (const file of files) {
  require(path.join(testDir, file));
}
