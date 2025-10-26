import fs from 'fs';
import os from 'os';
import path from 'path';

const configDir = path.join(os.homedir(), '.sshm');
const configPath = path.join(configDir, 'config.json');
const credentialPath = path.join(configDir, 'credentials.json');

export function ensureConfig() {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify([]));
  if (!fs.existsSync(credentialPath)) fs.writeFileSync(credentialPath, JSON.stringify({}));
}

export function getServers() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function saveServers(servers) {
  ensureConfig();
  fs.writeFileSync(configPath, JSON.stringify(servers, null, 2));
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
