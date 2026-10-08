import fs from 'fs';
import os from 'os';
import path from 'path';

const configDir = path.join(os.homedir(), '.sshm');
const configPath = path.join(configDir, 'config.json');
const legacyCredentialPath = path.join(configDir, 'credentials.json');
const keytarService = 'ssh-mate';
const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function ensureConfig() {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(configDir, 0o700);

  if (!fs.existsSync(configPath)) {
    writeJson(configPath, { servers: [] });
  } else {
    fs.chmodSync(configPath, 0o600);
  }
}

function writeJson(filePath, value) {
  const temporaryPath = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
}

function assertSafeName(name) {
  if (typeof name !== 'string' || !safeNamePattern.test(name)) {
    throw new Error('Tên server không hợp lệ.');
  }
}

function readConfig() {
  ensureConfig();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (Array.isArray(config)) return config;
  return config.servers || [];
}

async function getKeytar() {
  try {
    const module = await import('keytar');
    return module.default || module;
  } catch (error) {
    throw new Error('Không thể truy cập OS keyring. Hãy cài keytar và kiểm tra keyring của hệ điều hành: ' + error.message);
  }
}

async function migrateLegacyCredentials() {
  ensureConfig();
  if (!fs.existsSync(legacyCredentialPath)) return;

  const legacy = JSON.parse(fs.readFileSync(legacyCredentialPath, 'utf8')) || {};
  const entries = Object.entries(legacy);
  if (entries.length === 0) {
    fs.unlinkSync(legacyCredentialPath);
    return;
  }

  const keytar = await getKeytar();
  for (const [name, rawCredential] of entries) {
    assertSafeName(name);
    const credential = typeof rawCredential === 'string'
      ? { type: 'password', value: rawCredential }
      : rawCredential;
    if (!credential || !['password', 'key'].includes(credential.type) || typeof credential.value !== 'string') {
      throw new Error('Không thể chuyển credential cũ sang OS keyring: dữ liệu không hợp lệ cho server ' + name);
    }
    await keytar.setPassword(keytarService, credential.type + ':' + name, credential.value);
  }

  // Remove the plaintext file only after every entry has been stored successfully.
  fs.unlinkSync(legacyCredentialPath);
}

async function getSecret(type, name) {
  assertSafeName(name);
  await migrateLegacyCredentials();
  const keytar = await getKeytar();
  return keytar.getPassword(keytarService, type + ':' + name);
}

async function saveSecret(type, name, value) {
  assertSafeName(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Credential không được để trống.');
  }
  await migrateLegacyCredentials();
  const keytar = await getKeytar();
  await keytar.setPassword(keytarService, type + ':' + name, value);
}

export function getServers() {
  return readConfig();
}

export function saveServers(servers) {
  ensureConfig();
  writeJson(configPath, { servers });
}

export async function savePassword(name, password) {
  await saveSecret('password', name, password);
}

export async function getPassword(name) {
  return getSecret('password', name);
}

export async function saveKeyContent(name, keyContent) {
  await saveSecret('key', name, keyContent);
}

export async function getKeyContent(name) {
  return getSecret('key', name);
}

export async function regenerateKeyFile(name) {
  assertSafeName(name);
  const keyContent = await getKeyContent(name);
  if (!keyContent || !keyContent.includes('BEGIN') || !keyContent.includes('PRIVATE KEY')) {
    throw new Error('Không tìm thấy private key hợp lệ cho server: ' + name);
  }

  const keysDir = path.join(configDir, 'keys');
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(keysDir, 0o700);

  const keyFile = path.join(keysDir, name + '_key');
  fs.writeFileSync(keyFile, keyContent.trim() + '\n', { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  return '~/.sshm/keys/' + name + '_key';
}

export async function regenerateAllKeyFiles() {
  const servers = getServers();
  const keyServers = servers.filter(server => server.keyPath);
  const results = [];

  for (const server of keyServers) {
    try {
      const keyPath = await regenerateKeyFile(server.name);
      results.push({ name: server.name, status: 'success', path: keyPath });
    } catch (error) {
      results.push({ name: server.name, status: 'failed', reason: error.message });
    }
  }
  return results;
}

export async function deleteCredential(name) {
  assertSafeName(name);
  await migrateLegacyCredentials();
  const keytar = await getKeytar();
  await keytar.deletePassword(keytarService, 'password:' + name);
  await keytar.deletePassword(keytarService, 'key:' + name);
}
