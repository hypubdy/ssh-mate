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
  
  // Migrate old credentials format to new format
  migrateCredentials();
}

function migrateCredentials() {
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  let needsUpdate = false;
  
  for (const [name, value] of Object.entries(creds)) {
    // If value is a string (old format), convert to new format
    if (typeof value === 'string') {
      creds[name] = { type: 'password', value: value };
      needsUpdate = true;
    }
  }
  
  if (needsUpdate) {
    fs.writeFileSync(credentialPath, JSON.stringify(creds, null, 2));
    console.log('🔄 Đã cập nhật format credentials sang phiên bản mới');
  }
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

// Simple file-backed credential store (name -> password/key content)
// NOTE: storing plaintext passwords on disk is insecure. Prefer OS keyring or SSH keys.
export async function savePassword(name, password) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  creds[name] = { type: 'password', value: password };
  fs.writeFileSync(credentialPath, JSON.stringify(creds, null, 2));
}

export async function saveKeyContent(name, keyContent) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  creds[name] = { type: 'key', value: keyContent };
  fs.writeFileSync(credentialPath, JSON.stringify(creds, null, 2));
}

export async function getPassword(name) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  const cred = creds[name];
  if (cred && cred.type === 'password') {
    return cred.value;
  }
  return null;
}

export async function getKeyContent(name) {
  ensureConfig();
  const creds = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) || {};
  const cred = creds[name];
  if (cred && cred.type === 'key') {
    return cred.value;
  }
  return null;
}

export async function regenerateKeyFile(name) {
  ensureConfig();
  const keyContent = await getKeyContent(name);
  if (!keyContent) {
    throw new Error(`Không tìm thấy key content cho server: ${name}`);
  }
  
  // Validate key content
  if (!keyContent.includes('BEGIN') || !keyContent.includes('PRIVATE KEY')) {
    throw new Error(`Key content không hợp lệ cho server: ${name}`);
  }
  
  const keysDir = path.join(os.homedir(), '.sshm', 'keys');
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  }
  
  const keyFile = path.join(keysDir, `${name}_key`);
  
  // Write key with proper permissions
  fs.writeFileSync(keyFile, keyContent + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
    console.log(`🔑 Đã tái tạo key file: ~/.sshm/keys/${name}_key`);
    
    // Validate the generated key file
    try {
      const testKey = fs.readFileSync(keyFile, 'utf8');
      if (!testKey.includes('BEGIN') || !testKey.includes('PRIVATE KEY')) {
        throw new Error('Generated key file is invalid');
      }
    } catch (e) {
      throw new Error(`Key file validation failed: ${e.message}`);
    }
    
    return `~/.sshm/keys/${name}_key`;
  } catch (e) {
    console.log('⚠️ Không thể set quyền 600 cho file key');
    return `~/.sshm/keys/${name}_key`;
  }
}

export async function regenerateAllKeyFiles() {
  ensureConfig();
  const servers = getServers();
  const keyServers = servers.filter(s => s.keyPath);
  
  if (keyServers.length === 0) {
    console.log('⚠️ Không có server nào sử dụng SSH key.');
    return [];
  }
  
  const keysDir = path.join(os.homedir(), '.sshm', 'keys');
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    console.log('📁 Đã tạo lại thư mục keys');
  }
  
  const results = [];
  
  for (const server of keyServers) {
    try {
      const keyContent = await getKeyContent(server.name);
      if (!keyContent) {
        console.log(`⚠️ Không tìm thấy key content cho server: ${server.name}`);
        results.push({ name: server.name, status: 'failed', reason: 'No key content found' });
        continue;
      }
      
      const keyFile = path.join(keysDir, `${server.name}_key`);
      fs.writeFileSync(keyFile, keyContent + '\n', { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600);
      
      console.log(`🔑 Đã tái tạo key file: ~/.sshm/keys/${server.name}_key`);
      results.push({ name: server.name, status: 'success', path: `~/.sshm/keys/${server.name}_key` });
      
    } catch (error) {
      console.log(`⚠️ Lỗi khi tái tạo key cho ${server.name}: ${error.message}`);
      results.push({ name: server.name, status: 'failed', reason: error.message });
    }
  }
  
  return results;
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
