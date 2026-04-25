const fs = require('fs');

// 1. Create settings.js from popup.js
let js = fs.readFileSync('popup.js', 'utf8');
// Transform dynamic UI to use the new toggle structure
js = js.replace(/<label class="switch">[\s]*(<input[^>]*>)[\s]*<span class="slider"><\/span>[\s]*<\/label>/g, 
    '<label class="switch">\n            $1\n            <span class="slider"></span>\n          </label>');
// (In case I need to ensure it uses switch class if it was checkbox before, 
// but currently popup.js uses switch)
fs.writeFileSync('settings.js', js);

// 2. Create settings.html from popup.html
let html = fs.readFileSync('popup.html', 'utf8');

// Update Title & Script
html = html.replace('<title>Chroma Ad-Blocker</title>', '<title>Chroma Settings</title>');
html = html.replace('<script src="popup.js"></script>', '<script src="settings.js"></script>');

// Re-inject body styles for full-page look
html = html.replace(/body\s*\{[\s\S]*?-webkit-font-smoothing: antialiased;\s*\}/, `body {
      background: var(--bg-void);
      color: var(--text);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      overflow-x: hidden;
      position: relative;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    .main-container {
      max-width: 900px;
      margin: 40px auto;
      padding: 0 20px;
    }`);

// Wrap content in main-container
html = html.replace('<div class="grain"></div>', '<div class="grain"></div>\n  <div class="main-container">');
html = html.replace('</body>', '  </div>\n</body>');

// Update Font Sizes and Layout
html = html.replace('padding: 6px 12px 6px 8px;', 'padding: 16px 24px;'); // .pill-nav-inner
html = html.replace('width: 26px; height: 26px;', 'width: 40px; height: 40px;'); // .logo
html = html.replace('font-size: 13px; font-weight: 800;', 'font-size: 24px; font-weight: 800;'); // h1
html = html.replace('font-size: 9px; color: var(--text-dim);', 'font-size: 14px; color: var(--text-dim);'); // span
html = html.replace('font-size: 26px;', 'font-size: 40px;'); // .stat-value
html = html.replace('font-size: 20px;', 'font-size: 28px;'); // .stat-label
html = html.replace('font-size: 10px; font-weight: 700;', 'font-size: 14px; font-weight: 700;'); // .section-title
html = html.replace('font-size: 13px; font-weight: 600;', 'font-size: 16px; font-weight: 600;'); // .name
html = html.replace('font-size: 10.5px;', 'font-size: 13px;'); // .desc
html = html.replace('padding: 4px 10px;', 'padding: 8px 16px; font-size: 12px;'); // .reset-btn
html = html.replace('font-size: 10px; color: var(--text-dim); background: rgba(255,255,255,0.03);', 'font-size: 13px; color: var(--text-dim); background: rgba(255,255,255,0.03);');
html = html.replace('font-size: 10px; color: var(--text-muted); font-family: \'JetBrains Mono\'', 'font-size: 13px; color: var(--text-muted); font-family: \'JetBrains Mono\'');
html = html.replace('width: 14px;\n      height: 14px;', 'width: 20px;\n      height: 20px;'); // github link

// Remove header background & sticky
html = html.replace('background: rgba(4, 2, 12, 0.4);', '');
html = html.replace('backdrop-filter: blur(10px);', '');
html = html.replace('position: sticky; top: 0; z-index: 100;', '');
html = html.replace('padding: 14px 12px;', 'padding: 14px 12px 24px;');

// Remove settings icon from settings page
html = html.replace(/<svg id="settingsIcon"[\s\S]*?<\/svg>/, '');

// Resize Toggles for larger page
const oldSwitchCss = `    /* Premium Switch */
    .switch { position: relative; width: 34px; height: 18px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0; 
      background-color: #1e1e2e;
      background-size: 200% 100%;
      background-repeat: no-repeat;
      background-position: 0% 50%;
      border-radius: 20px; 
      transition: 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05); /* Inset shadow instead of border */
    }
    .slider::before {
      content: ''; position: absolute; height: 12px; width: 12px;
      left: 3px; top: 3px; background: #685e85;
      border-radius: 50%; transition: 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    input:checked + .slider { 
      background-image: linear-gradient(110deg, #ff0055, #9900ff, #0088ff);
      box-shadow: 0 0 12px rgba(153, 0, 255, 0.35); /* Outer glow only */
    }
    input:checked + .slider::before { transform: translateX(16px); background: #fff; }

    /* Hover effect: shift gradient on hover */
    .switch:hover input:checked + .slider {
      background-position: 100% 50%;
      filter: brightness(1.1);
      box-shadow: 0 0 18px rgba(153, 0, 255, 0.55);
    }

    /* Enable Switch (Header) */
    #toggleLabel { cursor: pointer; }
    .header-switch { width: 28px; height: 14px; }
    .header-switch .slider::before { height: 10px; width: 10px; left: 2px; top: 2px; }
    .header-switch input:checked + .slider::before { transform: translateX(14px); }

    /* Small Switch for Domain List */
    .switch-sm { width: 28px; height: 14px; }
    .switch-sm .slider::before { width: 10px; height: 10px; left: 2px; top: 2px; }
    .switch-sm input:checked + .slider::before { transform: translateX(14px); }`;

const newSwitchCss = `    /* Premium Switch */
    .switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; cursor: pointer; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0; 
      background-color: #1e1e2e;
      background-size: 200% 100%;
      background-repeat: no-repeat;
      background-position: 0% 50%;
      border-radius: 20px; 
      transition: 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
    }
    .slider::before {
      content: ''; position: absolute; height: 16px; width: 16px;
      left: 4px; top: 4px; background: #685e85;
      border-radius: 50%; transition: 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    input:checked + .slider { 
      background-image: linear-gradient(110deg, #ff0055, #9900ff, #0088ff);
      box-shadow: 0 0 12px rgba(153, 0, 255, 0.35);
    }
    input:checked + .slider::before { transform: translateX(20px); background: #fff; }

    /* Hover effect: shift gradient on hover */
    .switch:hover input:checked + .slider {
      background-position: 100% 50%;
      filter: brightness(1.1);
      box-shadow: 0 0 18px rgba(153, 0, 255, 0.55);
    }

    /* Enable Switch (Header) */
    #toggleLabel { cursor: pointer; }
    .header-switch { width: 34px; height: 18px; }
    .header-switch .slider::before { height: 12px; width: 12px; left: 3px; top: 3px; }
    .header-switch input:checked + .slider::before { transform: translateX(16px); }

    /* Small Switch for Domain List */
    .switch-sm { width: 34px; height: 18px; }
    .switch-sm .slider::before { width: 12px; height: 12px; left: 3px; top: 3px; }
    .switch-sm input:checked + .slider::before { transform: translateX(16px); }`;

html = html.replace(oldSwitchCss, newSwitchCss);

// Spacing adjustments
html = html.replace('margin: 0 12px 16px;', 'margin: 0 0 24px;');
html = html.replace('margin: 4px 12px 16px;', 'margin: 0 0 24px;');
html = html.replace(/padding: 10px 14px;/g, 'padding: 16px 20px;');
html = html.replace('padding: 12px 16px;', 'padding: 20px 24px;');
html = html.replace('margin-top: 1px;', 'margin-top: 4px;');
html = html.replace('gap: 12px; cursor: pointer;', 'gap: 20px; cursor: pointer;');

fs.writeFileSync('settings.html', html);
console.log('Successfully rebuilt settings features');
