const fs = require('fs/promises');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

const DEFAULT_CONFIG = {
  activeProvider: 'anthropic',
  apiKeys: {
    openai: null,
    gemini: null,
    mistral: null,
    anthropic: null,
  },
};

async function ensureFile() {
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

async function readConfig() {
  await ensureFile();
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(parsed.apiKeys || {}) },
  };
}

async function writeConfig(config) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getApiKey(provider) {
  const config = await readConfig();
  return config.apiKeys[provider] || null;
}

async function setApiKey(provider, key) {
  const config = await readConfig();
  config.apiKeys[provider] = key;
  await writeConfig(config);
}

async function getActiveProvider() {
  const config = await readConfig();
  return config.activeProvider;
}

async function setActiveProvider(provider) {
  const config = await readConfig();
  config.activeProvider = provider;
  await writeConfig(config);
}

async function getAllKeys() {
  const config = await readConfig();
  return config.apiKeys;
}

module.exports = {
  getApiKey,
  setApiKey,
  getActiveProvider,
  setActiveProvider,
  getAllKeys,
};
