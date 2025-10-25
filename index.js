#!/usr/bin/env node
/**
 * sshmate-cli - simple Node CLI to store ssh credentials in OS keyring and auto-login
 *
 * Usage:
 *   sshmate add
 *   sshmate list
 *   sshmate remove <alias>
 *   sshmate connect <alias>
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
import { spawn } from 'child_process';
import { getServers, saveServers, savePassword, getPassword, deletePassword } from './lib/store.js';

const program = new Command();

program
  .name('sshmate')
  .description('CLI quản lý và SSH nhanh vào server')
  .version('1.0.0');

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
      { type: 'input', name: 'keyPath', message: 'Đường dẫn private key:', default: '~/.ssh/id_rsa', when: a => a.auth === 'key' }
    ]);

    const servers = getServers();
    const server = {
      name: answers.name,
      host: answers.host,
      user: answers.user,
      port: answers.port || '22'  // Đảm bảo luôn có giá trị mặc định là 22
    };
    if (answers.auth === 'key') {
      server.keyPath = answers.keyPath;
    }
    servers.push(server);
    saveServers(servers);

    if (answers.auth === 'password') {
      await savePassword(answers.name, answers.password);
    }

    console.log(`✅ Đã lưu server "${answers.name}"`);
  });

program
  .command('list')
  .description('Liệt kê danh sách server')
  .action(() => {
    const servers = getServers();
    console.table(servers);
  });

program
  .command('connect')
  .description('Chọn server để SSH')
  .action(async () => {
    const servers = getServers();
    if (servers.length === 0) return console.log('⚠️ Chưa có server nào.');

    const { name } = await inquirer.prompt([
      {
        type: 'list',
        name: 'name',
        message: 'Chọn server để SSH:',
        choices: servers.map(s => s.name)
      }
    ]);

  const server = servers.find(s => s.name === name);
    
    // Đảm bảo server luôn có port, mặc định là 22
    if (!server.port) server.port = '22';

    // If server has keyPath, use SSH key; otherwise fall back to password
    if (server.keyPath) {
      // expand ~ to home
      const keyPath = server.keyPath.replace(/^~(?=$|\/)/, os.homedir());
      if (!fs.existsSync(keyPath)) return console.log(`⚠️ Không tìm thấy file key: ${keyPath}`);
      console.log(`🔐 Đang kết nối bằng SSH key tới ${server.user}@${server.host}...`);
      console.log(`🔑 Sử dụng SSH key: ${keyPath}`);
      const ssh = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-p', server.port,
        '-i', keyPath,
        `${server.user}@${server.host}`
      ], { stdio: 'inherit' });

      ssh.on('exit', code => {
        console.log(`🔌 Đã thoát khỏi SSH với mã: ${code}`);
        process.exit(code);
      });
      return;
    }

    const password = await getPassword(name);

    if (!password) return console.log('⚠️ Không tìm thấy password đã lưu.');
    console.log(`🔐 Đang kết nối tới ${server.user}@${server.host}...`);
    // Dùng sshpass + spawn để ssh tự động
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
  });

program.parseAsync();
