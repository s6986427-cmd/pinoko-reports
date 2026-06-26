#!/usr/bin/env node
const { spawnSync, execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');

const USERNAME = 's6986427-cmd';
const REPO = 'pinoko-reports';
const SRC = '/Users/chun/Desktop/pinoko-web';

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n',
    encoding: 'utf8'
  });
  const m = r.stdout.match(/^password=(.+)$/m);
  if (!m) throw new Error('找不到 GitHub 憑證');
  return m[1].trim();
}

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path, method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'pinoko-deploy',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function git(...args) {
  const r = spawnSync('git', ['-C', SRC, ...args], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  if (r.status !== 0 && r.stderr && !r.stderr.includes('nothing to commit')) {
    console.log(r.stderr.trim());
  }
  return r.stdout.trim();
}

async function main() {
  const token = getToken();

  // 建立或確認 repo
  let repoRes = await api('GET', `/repos/${USERNAME}/${REPO}`, token);
  if (repoRes.status === 404) {
    console.log('建立 GitHub repo...');
    repoRes = await api('POST', '/user/repos', token, {
      name: REPO,
      description: '皮諾可泡沫紅茶 報表中心（密碼保護）',
      private: false,
      auto_init: false
    });
    if (repoRes.status !== 201) throw new Error(`建立失敗: ${JSON.stringify(repoRes.body)}`);
    console.log('✓ repo 建立完成');
  } else {
    console.log('✓ repo 已存在');
  }

  // 寫臨時憑證給 git 用（push 後立刻刪除）
  const credFile = '/tmp/pinoko_gh_cred';
  fs.writeFileSync(credFile, `https://${USERNAME}:${token}@github.com\n`, { mode: 0o600 });

  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 's6986427@gmail.com');
    git('config', 'user.name', USERNAME);
    git('config', 'credential.helper', `store --file ${credFile}`);
    git('remote', 'remove', 'origin');
    git('remote', 'add', 'origin', `https://github.com/${USERNAME}/${REPO}.git`);
    git('add', '.');

    const status = git('status', '--porcelain');
    if (status) {
      git('commit', '-m', '更新皮諾可報表（已加密碼保護）');
    }

    // 先 pull rebase，避免其他腳本同時推送導致 rejected
    spawnSync('git', ['-C', SRC, 'pull', '--rebase', 'origin', 'main'], {
      encoding: 'utf8', stdio: 'inherit',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    console.log('推送到 GitHub...');
    const pushResult = spawnSync('git', ['-C', SRC, 'push', '-u', 'origin', 'main'], {
      encoding: 'utf8', stdio: 'inherit',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    if (pushResult.status !== 0) throw new Error('推送失敗');
    console.log('✓ 推送完成');
  } finally {
    // 立刻刪除憑證檔案
    try { fs.unlinkSync(credFile); } catch {}
    // 清除 git 設定裡的憑證 helper
    git('config', '--unset', 'credential.helper');
  }

  // 啟用 GitHub Pages
  let pagesRes = await api('POST', `/repos/${USERNAME}/${REPO}/pages`, token, {
    source: { branch: 'main', path: '/' }
  });
  if (pagesRes.status === 422) {
    // 已存在，更新設定
    pagesRes = await api('PUT', `/repos/${USERNAME}/${REPO}/pages`, token, {
      source: { branch: 'main', path: '/' }
    });
  }

  const url = `https://${USERNAME}.github.io/${REPO}/`;
  console.log('\n✅ 部署完成！');
  console.log(`🔗 網址：${url}`);
  console.log('（GitHub Pages 約需 1-2 分鐘生效，請稍等再打開）');
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
