import fs from 'fs';
import os from 'os';
import path from 'path';

const configDir = path.join(os.homedir(), '.sshm');
const configPath = path.join(configDir, 'config.json');
const credentialPath = path.join(configDir, 'credentials.json');

export function ensureConfig() {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ servers: [] }, null, 2));
  if (!fs.existsSync(credentialPath)) fs.writeFileSync(credentialPath, JSON.stringify({}));
}

export function getServers() {
  ensureConfig();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // Handle both old format (array) and new format (object with servers array)
  if (Array.isArray(config)) {
    return config;
  }
  return config.servers || [];
}

export function saveServers(servers) {
  ensureConfig();
  const config = { servers };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Simple file-backed credential store (name -> password)
// NOTE: storing plaintext passwords on disk is insecure. Prefer OS keyring or SSH keys.
export async function savePassword(name, password) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  creds[name] = password;
  fs.writeFileSync(credentialPath, JSON.stringify(creds, null, 2));
}

export async function getPassword(name) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  return creds[name] ?? null;
}

export async function deletePassword(name) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  if (creds[name]) {
    delete creds[name];
    fs.writeFileSync(credentialPath, JSON.stringify(creds, null, 2));
    return true;
  }
  return false;
}
