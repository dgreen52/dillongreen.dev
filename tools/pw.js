// Shared Playwright loader. Playwright is borrowed from a sibling project so this
// folder needs no node_modules of its own; override with PLAYWRIGHT_PATH.
const path = require("path");
const PW = process.env.PLAYWRIGHT_PATH ||
  path.resolve(__dirname, "..", "..", "pocket429", "node_modules", "playwright");
const { chromium, webkit, devices } = require(PW);

async function launch(extraArgs = []) {
  // Use the system Edge so no browser download is needed.
  return chromium.launch({ channel: "msedge", headless: true, args: extraArgs });
}

// WebKit (what iPhones run). Needs a one-time, local-only browser download:
//   node ../pocket429/node_modules/playwright/cli.js install webkit
async function launchWebKit() {
  return webkit.launch({ headless: true });
}

module.exports = { chromium, webkit, devices, launch, launchWebKit };
