const fs = require('fs/promises');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

const DEFAULT_CONFIG = {
  activeProvider: 'mistral',
  apiKeys: {
    openai: null,
    gemini: null,
    mistral: null,
    anthropic: null,
  },
};

// Env var names checked as a fallback when no key has been set via the
// WhatsApp control room yet (handy for Railway/Render "Variables" tab).
const ENV_KEY_NAMES = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const VALID_PROVIDERS = ['openai', 'gemini', 'mistral', 'anthropic'];

async function ensureFile() {
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}
