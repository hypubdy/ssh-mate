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

const { Command } = require("commander");
const inquirer = require("inquirer");
const keytar = require("keytar");
const pty = require("node-pty");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const program = new Command();
const APP_NAME = "sshmate-cli";
const CONFIG_DIR = path.join(os.homedir(), ".config", "sshmate-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "hosts.json");

async function ensureConfig() {
  await fs.ensureDir(CONFIG_DIR);
  if (!(await fs.pathExists(CONFIG_FILE))) {
    await fs.writeJson(CONFIG_FILE, {});
  }
}

async function loadHosts() {
  await ensureConfig();
  return fs.readJson(CONFIG_FILE);
}

async function saveHosts(obj) {
  await ensureConfig();
  return fs.writeJson(CONFIG_FILE, obj, { spaces: 2 });
}

function promptYesNo(message) {
  return inquirer.prompt([{ type: "confirm", name: "ok", message, default: false }])
    .then(r => r.ok);
}

program
  .name("sshmate")
  .description("Store ssh credentials (OS keyring) and auto-login")
  .version("1.0.0");

program
  .command("add")
  .description("Add a host entry")
  .action(async () => {
    const hosts = await loadHosts();
    const answers = await inquirer.prompt([
      { name: "alias", message: "Alias (short name):", validate: v => v ? true : "Required" },
      { name: "host", message: "Host (hostname or ip):", validate: v => v ? true : "Required" },
      { name: "user", message: "User:", default: process.env.USER || "" },
      { name: "port", message: "Port:", default: "22" },
      {
        type: "list", name: "auth", message: "Authentication method:",
        choices: [{name:"password", value:"password"}, {name:"key (identity file)", value:"key"}]
      },
      { name: "keypath", message: "Path to private key (if key):", when: a => a.auth === "key", default: "~/.ssh/id_ed25519" }
    ]);

    const alias = answers.alias;
    if (hosts[alias]) {
      const ok = await promptYesNo(`Alias ${alias} exists. Overwrite?`);
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    hosts[alias] = {
      host: answers.host,
      user: answers.user,
      port: parseInt(answers.port, 10) || 22,
      auth: answers.auth,
      keypath: answers.auth === "key" ? answers.keypath.replace(/^~(?=$|\/)/, os.homedir()) : null
    };

    await saveHosts(hosts);

    if (answers.auth === "password") {
      const pwAnswer = await inquirer.prompt([{ type: "password", name: "pw", message: `Password for ${answers.user}@${answers.host}:` }]);
      const account = `${alias}@${answers.host}`;
      await keytar.setPassword(APP_NAME, account, pwAnswer.pw);
      console.log(`Saved password to OS keyring (service=${APP_NAME}, account=${account}).`);
    }

    console.log(`Saved host ${alias}.`);
  });

program
  .command("list")
  .description("List saved hosts")
  .action(async () => {
    const hosts = await loadHosts();
    const keys = Object.keys(hosts);
    if (!keys.length) {
      console.log("No hosts saved.");
      return;
    }
    for (const k of keys) {
      const h = hosts[k];
      console.log(`${k} -> ${h.user}@${h.host}:${h.port} (${h.auth}${h.keypath ? ", key=" + h.keypath : ""})`);
    }
  });

program
  .command("remove <alias>")
  .description("Remove saved host and credential")
  .action(async (alias) => {
    const hosts = await loadHosts();
    if (!hosts[alias]) {
      console.log("Alias not found.");
      return;
    }
    const ok = await promptYesNo(`Remove ${alias}?`);
    if (!ok) { console.log("Aborted."); return; }
    const account = `${alias}@${hosts[alias].host}`;
    if (hosts[alias].auth === "password") {
      try { await keytar.deletePassword(APP_NAME, account); } catch(e) {}
    }
    delete hosts[alias];
    await saveHosts(hosts);
    console.log("Removed.");
  });

program
  .command("connect <alias>")
  .description("Connect to saved host (auto-supply password if stored)")
  .action(async (alias) => {
    const hosts = await loadHosts();
    const entry = hosts[alias];
    if (!entry) {
      console.log("Alias not found. Use `sshmate add` first.");
      return;
    }

    const userAtHost = `${entry.user}@${entry.host}`;
    const portArg = entry.port ? ["-p", String(entry.port)] : [];
    let sshArgs = [...portArg, userAtHost];

    if (entry.auth === "key" && entry.keypath) {
      sshArgs = ["-i", entry.keypath, ...sshArgs];
    }

    // spawn pty for interactive ssh
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
    const cmd = "ssh";
    const p = pty.spawn(cmd, sshArgs, {
      name: 'xterm-color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: process.cwd(),
      env: process.env
    });

    // pipe pty <-> stdout/stdin
    p.onData(data => process.stdout.write(data));
    process.stdin.setRawMode && process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', d => {
      try { p.write(d.toString()); } catch(e) {}
    });

    // fetch password from keyring if needed
    let password = null;
    if (entry.auth === "password") {
      const account = `${alias}@${entry.host}`;
      password = await keytar.getPassword(APP_NAME, account);
      if (!password) {
        console.log("\nPassword not found in keyring. Please run `sshmate add` to store it, or cancel and enter password interactively.");
      }
    }

    // detect prompts and reply
    let promptedOnce = false;
    p.onData(async (chunk) => {
      const s = chunk.toString();
      // host key confirmation
      if (/are you sure you want to continue connecting \(yes\/no\)\?/i.test(s)) {
        p.write("yes\r");
        return;
      }
      // password prompt
      if (/password:|passphrase for key .*:|enter passphrase for key .*:/i.test(s)) {
        if (password) {
          // send password + newline
          p.write(password + "\r");
        } else if (!promptedOnce) {
          // fallback: let user type password interactively
          console.log("\nPlease type password (it will be sent to ssh):");
          promptedOnce = true;
        }
      }
    });

    p.onExit(() => {
      // restore stdin mode
      try {
        process.stdin.setRawMode && process.stdin.setRawMode(false);
      } catch (e) {}
      process.stdin.pause();
      // exit process when ssh ends
      process.exit(0);
    });
  });

program.parseAsync(process.argv).catch(err => {
  console.error("Error:", err);
  process.exit(1);
});

