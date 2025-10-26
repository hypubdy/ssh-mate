#!/usr/bin/env node
/**
 * sshm-cli - simple Node CLI to store ssh credentials in OS keyring and auto-login
 *
 * Usage:
 *   sshm add
 *   sshm list
 *   sshm remove <alias>
 *   sshm connect <alias>
 *   sshm <alias>
 *
 * Notes:
 *  - Requires: ssh available in PATH
 *  - Uses keytar to store passwords securely in OS keyring
 *  - Uses node-pty to spawn a pty and detect password prompts, host key prompts
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { getServers, saveServers, savePassword, getPassword, deletePassword, saveKeyContent, regenerateKeyFile, regenerateAllKeyFiles } from './lib/store.js';

// Function to handle SSH connection
async function handleSSH(name) {
  const servers = getServers();
  if (servers.length === 0) return console.log('⚠️ Chưa có server nào.');

  const server = servers.find(s => s.name === name);
  if (!server) return console.log(`⚠️ Không tìm thấy server: ${name}`);

  // Đảm bảo server luôn có port, mặc định là 22
  if (!server.port) server.port = '22';

  // If server has keyPath, use SSH key; otherwise fall back to password
  if (server.keyPath) {
    // expand ~ to home
    let keyPath = server.keyPath.replace(/^~(?=$|\/)/, os.homedir());
    
    // If key file doesn't exist, try to regenerate it from stored content
    if (!fs.existsSync(keyPath)) {
      console.log(`⚠️ Không tìm thấy file key: ${keyPath}`);
      console.log(`🔄 Đang thử tái tạo key file...`);
      try {
        keyPath = await regenerateKeyFile(name);
        keyPath = keyPath.replace(/^~(?=$|\/)/, os.homedir());
        if (!fs.existsSync(keyPath)) {
          return console.log(`⚠️ Không thể tái tạo key file cho server: ${name}`);
        }
      } catch (error) {
        return console.log(`⚠️ ${error.message}`);
      }
    }
    
    // Validate key file before using
    try {
      const keyContent = fs.readFileSync(keyPath, 'utf8');
      if (!keyContent.includes('BEGIN') || !keyContent.includes('PRIVATE KEY')) {
        console.log(`⚠️ Key file không hợp lệ: ${keyPath}`);
        console.log(`🔄 Đang thử tái tạo key file...`);
        try {
          keyPath = await regenerateKeyFile(name);
          keyPath = keyPath.replace(/^~(?=$|\/)/, os.homedir());
        } catch (error) {
          return console.log(`⚠️ Không thể tái tạo key file: ${error.message}`);
        }
      }
    } catch (e) {
      console.log(`⚠️ Không thể đọc key file: ${keyPath}`);
      return;
    }
    
    console.log(`🔐 Đang kết nối bằng SSH key tới ${server.user}@${server.host}:${server.port}...`);
    // console.log(`🔑 Sử dụng SSH key: ${keyPath}`);
    const ssh = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', server.port,
      '-i', keyPath,
      `${server.user}@${server.host}`
    ], { stdio: 'inherit' });

    ssh.on('exit', code => {
      if (code === 0) {
        console.log(`🔌 Đã thoát khỏi SSH thành công`);
      } else {
        console.log(`🔌 SSH connection failed với mã: ${code}`);
        if (code === 255) {
          console.log(`💡 Gợi ý: Kiểm tra lại key file hoặc server có chấp nhận key này không`);
        }
      }
      process.exit(code);
    });
    return;
  }

  const password = await getPassword(name);
  if (!password) return console.log('⚠️ Không tìm thấy password đã lưu.');
  
  console.log(`🔐 Đang kết nối tới ${server.user}@${server.host}:${server.port}...`);
  const sshPassProc = spawn('sshpass', [
    '-p', password,
    'ssh',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-p', server.port,
    `${server.user}@${server.host}`
  ], {
    stdio: 'inherit'
  });

  sshPassProc.on('exit', code => {
    console.log(`🔌 Đã thoát khỏi SSH với mã: ${code}`);
    process.exit(code);
  });
}

const program = new Command();

program
  .name('sshm')
  .description('CLI quản lý và SSH nhanh vào server')
  .version('1.0.0')
  .argument('[name]', 'Tên server để kết nối trực tiếp')
  .action(async (name) => {
    try {
      let serverName = name;
      const servers = getServers();

      if (!serverName) {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'name',
            message: 'Chọn server để SSH:',
            choices: servers.map(s => `${s.name} (${s.user}@${s.host}:${s.port || '22'})`)
          }
        ]);
        serverName = answer.name.split(' ')[0]; // Lấy phần tên trước dấu space
      }

      await handleSSH(serverName);
    } catch (e) {
      program.help()
    }
  });

program
  .command('add')
  .description('Thêm server mới')
  .action(async () => {
    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Tên server:' },
      { type: 'input', name: 'host', message: 'Địa chỉ host:' },
      { type: 'input', name: 'user', message: 'Tên user SSH:' },
      { type: 'input', name: 'port', message: 'Port SSH:', default: '22' },
      {
        type: 'list',
        name: 'auth',
        message: 'Phương thức xác thực:',
        choices: [
          { name: 'Password', value: 'password' },
          { name: 'SSH key', value: 'key' }
        ],
        default: 'password'
      },
      { type: 'password', name: 'password', message: 'Mật khẩu SSH:', when: a => a.auth === 'password' },
      {
        type: 'list',
        name: 'keyMethod',
        message: 'Cách nhập key:',
        when: a => a.auth === 'key',
        choices: [
          { name: 'Dùng file key có sẵn', value: 'file' },
          { name: 'Dán nội dung key', value: 'paste' }
        ]
      },
      { type: 'input', name: 'keyPath', message: 'Đường dẫn private key:', default: '~/.ssh/id_rsa', when: a => a.auth === 'key' && a.keyMethod === 'file' },
      { type: 'editor', name: 'keyContent', message: 'Dán nội dung private key vào đây (Ctrl+S để lưu, Ctrl+Q để thoát):', when: a => a.auth === 'key' && a.keyMethod === 'paste' }
    ]);

    const servers = getServers();
    const server = {
      name: answers.name,
      host: answers.host,
      user: answers.user,
      port: answers.port || '22'
    };

    if (answers.auth === 'key') {
      if (answers.keyMethod === 'paste' && answers.keyContent) {
        // write pasted key content to a secure file under ~/.sshm/keys
        const keysDir = path.join(os.homedir(), '.sshm', 'keys');
        if (!fs.existsSync(keysDir)) {
          fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        }
        
        const keyFile = path.join(keysDir, `${answers.name}_key`);
        
        // Validate key content
        const keyContent = answers.keyContent.trim();
        if (!keyContent) {
          console.log('⚠️ Không có nội dung key. Hủy.');
          return;
        }
        
        if (!keyContent.includes('PRIVATE KEY')) {
          console.log('⚠️ Nội dung không phải private key hợp lệ. Hủy.');
          return;
        }
        
        // Write key with proper permissions
        fs.writeFileSync(keyFile, keyContent + '\n', { mode: 0o600 });
        try {
          fs.chmodSync(keyFile, 0o600);
          console.log(`🔑 Đã lưu key vào: ~/.sshm/keys/${answers.name}_key`);
        } catch (e) {
          console.log('⚠️ Không thể set quyền 600 cho file key');
        }
        
        // Save key content to credentials for regeneration
        await saveKeyContent(answers.name, keyContent);
        
        server.keyPath = `~/.sshm/keys/${answers.name}_key`;
      } else if (answers.keyMethod === 'file') {
        // Lưu đường dẫn với ~/
        server.keyPath = answers.keyPath;
        // Kiểm tra file tồn tại bằng đường dẫn đầy đủ
        const fullKeyPath = answers.keyPath.replace(/^~(?=$|\/)/, os.homedir());
        if (!fs.existsSync(fullKeyPath)) {
          console.log(`⚠️ Không tìm thấy file key: ${answers.keyPath}`);
          return;
        }
      } else {
        console.log('⚠️ Thiếu thông tin key SSH. Hủy.');
        return;
      }
    }

    servers.push(server);
    saveServers(servers);

    if (answers.auth === 'password') {
      await savePassword(answers.name, answers.password);
    }

    console.log(`✅ Đã lưu server "${answers.name}"`);
  });

program
  .command('ls')
  .description('Liệt kê danh sách server')
  .action(() => {
    const servers = getServers();
    if (servers.length === 0) return console.log('⚠️ Chưa có server nào.');
    
    // Hiển thị chỉ thông tin auth type
    const authInfo = servers.map(server => ({
      name: server.name,
      host: server.host,
      auth: server.keyPath ? 'SSH Key' : 'Password'
    }));
    
    console.table(authInfo);
  });

program
  .command('rm [name]')
  .description('Xóa server theo tên (nếu không truyền sẽ hiển thị menu)')
  .action(async (name) => {
    const servers = getServers();
    if (servers.length === 0) return console.log('⚠️ Chưa có server nào.');

    let targetName = name;
    if (!targetName) {
      const answer = await inquirer.prompt([{ type: 'list', name: 'name', message: 'Chọn server cần xóa:', choices: servers.map(s => s.name) }]);
      targetName = answer.name;
    }

    const idx = servers.findIndex(s => s.name === targetName);
    if (idx === -1) return console.log(`⚠️ Không tìm thấy server: ${targetName}`);

    const { confirm } = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message: `Bạn có chắc muốn xóa "${targetName}"?`, default: false }]);
    if (!confirm) return console.log('Hủy xóa.');

    const [removed] = servers.splice(idx, 1);
    saveServers(servers);

    // delete password if any
    try { await deletePassword(removed.name); } catch (e) { /* ignore */ }

    // delete key file if it is inside ~/.sshm/keys
    try {
      const keysDir = path.join(os.homedir(), '.sshm', 'keys');
      const fullKeyPath = removed.keyPath ? removed.keyPath.replace(/^~(?=$|\/)/, os.homedir()) : null;
      if (fullKeyPath && fullKeyPath.startsWith(keysDir) && fs.existsSync(fullKeyPath)) {
        fs.unlinkSync(fullKeyPath);
      }
    } catch (e) { /* ignore */ }

    console.log(`✅ Đã xóa server "${targetName}"`);
  });

program
  .command('connect [name]')
  .description('Chọn server để SSH')
  .action(async (nameArg) => {
    const servers = getServers();
    if (servers.length === 0) return console.log('⚠️ Chưa có server nào.');

    let targetName = nameArg;
    if (!targetName) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'name',
          message: 'Chọn server để SSH:',
          choices: servers.map(s => `${s.name} (${s.user}@${s.host}:${s.port || '22'})`)
        }
      ]);
      targetName = answer.name.split(' ')[0]; // Lấy phần tên trước dấu space
    }

    await handleSSH(targetName);
  });

program
  .command('regen [name]')
  .description('Tái tạo key file từ content đã lưu')
  .action(async (nameArg) => {
    const servers = getServers();
    const keyServers = servers.filter(s => s.keyPath);
    
    if (keyServers.length === 0) return console.log('⚠️ Không có server nào sử dụng SSH key.');
    
    let targetName = nameArg;
    if (!targetName) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'name',
          message: 'Chọn server để tái tạo key:',
          choices: keyServers.map(s => `${s.name} (${s.user}@${s.host})`)
        }
      ]);
      targetName = answer.name.split(' ')[0]; // Lấy phần tên trước dấu space
    }
    
    try {
      await regenerateKeyFile(targetName);
      console.log(`✅ Đã tái tạo key file cho server "${targetName}"`);
    } catch (error) {
      console.log(`⚠️ ${error.message}`);
    }
  });

program
  .command('regen-all')
  .description('Tái tạo tất cả key files từ content đã lưu (dùng khi thư mục keys bị xóa)')
  .action(async () => {
    console.log('🔄 Đang tái tạo tất cả key files...');
    const results = await regenerateAllKeyFiles();
    
    if (results.length === 0) {
      console.log('ℹ️ Không có key nào để tái tạo.');
      return;
    }
    
    const successCount = results.filter(r => r.status === 'success').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    
    console.log(`\n📊 Kết quả tái tạo:`);
    console.log(`✅ Thành công: ${successCount}`);
    console.log(`❌ Thất bại: ${failedCount}`);
    
    if (failedCount > 0) {
      console.log('\n⚠️ Các key thất bại:');
      results.filter(r => r.status === 'failed').forEach(r => {
        console.log(`  - ${r.name}: ${r.reason}`);
      });
    }
  });

program.parseAsync();