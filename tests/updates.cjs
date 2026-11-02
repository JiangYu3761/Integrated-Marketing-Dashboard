// UI/bridge contract tests; native installation is validated on macOS separately.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  const url = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:8877/';
  try {
    const ordinary = await browser.newContext();
    const plain = await ordinary.newPage();
    await plain.goto(url);
    assert(await plain.locator('#mm-update-check').isDisabled());
    assert(await plain.locator('#mm-update-auto').isDisabled());
    assert((await plain.locator('#mm-update-status').innerText()).includes('独立 Mac 应用'));
    await ordinary.close();
    console.log('PASS: browser mode clearly distinguishes unavailable native installation');

    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    await context.addInitScript(() => {
      window.testUpdateMessages = [];
      window.webkit = { messageHandlers: { desktopUpdates: { postMessage(message) {
        window.testUpdateMessages.push(message);
        if (message.action === 'status') queueMicrotask(() => window.dispatchEvent(new CustomEvent('desktop-update-status', {
          detail: { version: '1.1.0', phase: 'idle', automatic: true, busy: false, message: '启动时及每 6 小时自动检查，有新版时自动安装。' },
        })));
      } } } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#mm-update-version').textContent(), '当前版本 1.1.0');
    assert(await page.locator('#mm-update-auto').isChecked());
    await page.locator('#mm-update-check').click();
    assert((await page.evaluate(() => window.testUpdateMessages)).some(message => message.action === 'check'));
    await page.locator('#mm-update-auto').uncheck();
    assert.deepEqual((await page.evaluate(() => window.testUpdateMessages)).at(-1), { action: 'automatic', enabled: false });
    console.log('PASS: current version, manual update request and automatic-update preference bridge');

    const publish = detail => page.evaluate(value => window.dispatchEvent(new CustomEvent('desktop-update-status', { detail: value })), detail);
    await publish({ version: '1.1.0', phase: 'checking', automatic: true, busy: true, message: '正在检查更新并准备安装包…' });
    assert(await page.locator('#mm-update-check').isDisabled());
    await publish({ version: '1.1.0', phase: 'unpublished', automatic: true, busy: false, checkedAt: '2026-11-02T05:00:00Z', message: '暂未找到可用的已发布更新。' });
    assert(!(await page.locator('#mm-update-check').isDisabled()));
    assert((await page.locator('#mm-update-time').innerText()).includes('13:00'));
    await publish({ version: '1.1.0', phase: 'ready', automatic: true, latestVersion: '1.2.0', busy: false, message: '新版已下载。请先保存或取消当前编辑。' });
    assert((await page.locator('#mm-update-version').innerText()).includes('新版 1.2.0'));
    assert(await page.evaluate(() => window.dashboardCanInstallUpdate()));
    await page.locator('#mm-add-task').click();
    await page.locator('#mm-task-form [name=title]').fill('尚未保存的编辑');
    assert(!(await page.evaluate(() => window.dashboardCanInstallUpdate())));
    await page.locator('#mm-cancel-task').click();
    assert(await page.evaluate(() => window.dashboardCanInstallUpdate()));
    await page.locator('#mm-settings').click();
    assert(!(await page.evaluate(() => window.dashboardCanInstallUpdate())));
    await page.locator('#mm-close-settings').click();
    assert(await page.evaluate(() => window.dashboardCanInstallUpdate()));
    console.log('PASS: no-release and queued-update states, Shanghai check time, unsaved editors defer restart');

    await publish({ version: '1.1.0', phase: 'error', automatic: true, busy: false, message: '<img src=x onerror=alert(1)> 下载失败' });
    assert.equal(await page.locator('#mm-update-status img').count(), 0);
    assert((await page.locator('#mm-update-status').innerText()).includes('<img'));
    await publish({ version: '1.1.0', phase: 'installing', automatic: true, busy: false, message: '正在安装新版，即将自动重启。' });
    assert(await page.locator('#mm-update-check').isDisabled());
    assert(await page.locator('#mm-update-auto').isDisabled());
    await page.evaluate(() => window.dashboardSetUpdateLock(true));
    assert(await page.locator('#market-map-template').evaluate(root => root.inert));
    await page.evaluate(() => window.dashboardSetUpdateLock(false));
    await publish({ version: '1.2.0', phase: 'installed', automatic: true, busy: false, message: '已自动更新到 1.2.0。' });
    assert.equal(await page.locator('#mm-update-version').textContent(), '当前版本 1.2.0');
    await page.setViewportSize({ width: 390, height: 844 });
    const width = await page.locator('#mm-updates').evaluate(panel => panel.getBoundingClientRect().width);
    assert(width <= 390);
    // Screenshot represents the currently unpublished channel, rather than a
    // fabricated successful installation from the bridge fixture above.
    await publish({ version: '1.1.0', phase: 'unpublished', automatic: true, busy: false, message: '暂未找到可用的已发布更新。' });
    if (process.env.UPDATE_SCREENSHOT) await page.locator('#mm-updates').screenshot({ path: process.env.UPDATE_SCREENSHOT });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS: safe status text, installation lock, installed version and narrow-screen update area');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
