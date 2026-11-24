// Exercise storage rejection, local drafts and JSON migration through the actual UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (window.rejectWrites) throw new DOMException('test full storage', 'QuotaExceededError');
        return write.call(this, key, value);
      };
    });
    await page.goto(process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:8877/');
    const state = () => page.evaluate(() => window.projectState.read().privateContent.data);
    await page.locator('#mm-tab-time').click();
    await page.locator('#mm-add-task').click();
    const title = page.locator('#mm-task-form [name=title]');
    await title.fill('草稿标题');
    await page.locator('#mm-task-form [name=notes]').fill('草稿备注');
    await page.reload();
    assert.equal(await title.inputValue(), '草稿标题');
    assert.equal(await page.locator('#mm-task-form [name=notes]').inputValue(), '草稿备注');
    assert.equal((await state()).tasks.length, 0);
    await page.evaluate(() => { window.rejectWrites = true; });
    await page.locator('#mm-save-task').click();
    assert(await page.locator('#mm-task-dialog').isVisible());
    assert.match(await page.locator('#mm-task-error').textContent(), /空间不足/);
    assert.equal((await state()).tasks.length, 0);
    await page.evaluate(() => { window.rejectWrites = false; });
    await page.locator('#mm-save-task').click();
    assert.equal((await state()).tasks.length, 1);
    assert.equal((await state()).taskDrafts.length, 0);

    await page.locator('[data-role-new]').first().click();
    const quick = page.locator('#mm-quick-form [name=title]');
    await quick.fill('快速录入草稿');
    await page.reload();
    assert.equal(await quick.inputValue(), '快速录入草稿');
    await page.locator('#mm-quick-more').click();
    assert.equal(await title.inputValue(), '快速录入草稿');
    await page.reload();
    assert.equal(await title.inputValue(), '快速录入草稿');
    await page.locator('#mm-cancel-task').click();
    assert.equal((await state()).taskDrafts.length, 0);

    await page.locator('#mm-product-menu summary').click();
    await page.locator('#mm-tab-table').click();
    await page.evaluate(() => { window.rejectWrites = true; });
    await page.locator('#mm-view-table [data-complete-task]').first().click();
    assert.equal((await state()).tasks[0].status, '待开始');
    assert.equal(await page.locator('#mm-view-table [data-complete-task]').first().isChecked(), false);
    await page.evaluate(() => { window.rejectWrites = false; });
    await page.locator('#mm-view-table [data-complete-task]').first().click();

    await page.locator('#mm-admin-menu summary').click();
    await page.locator('#mm-tab-backup').click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('[data-export]').click();
    const download = await downloadEvent;
    const file = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    const task = file.privateContent.data.tasks[0];
    assert.equal(task.status, '已完成');
    assert(task.completedAt);
    const input = page.locator('[data-import]');
    await input.setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    await page.locator('[data-backup-status]').filter({hasText:'备份未导入'}).waitFor();
    assert.equal((await state()).tasks[0].id, task.id);
    // An older saved schema must go through the normal existing migration.
    file.privateContent.data.version = 4;
    task.title = '从旧版本恢复';
    await input.setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
    const restore = page.getByRole('button', { name: '确认恢复此备份' });
    await restore.waitFor();
    assert.equal((await state()).tasks[0].title, '草稿标题');
    await Promise.all([page.waitForNavigation(), restore.click()]);
    const restored = (await state()).tasks[0];
    assert.deepEqual([restored.id,restored.title,restored.completedAt],[task.id,'从旧版本恢复',task.completedAt]);
    assert.deepEqual(errors, []);
    console.log('PASS: task and quick draft recovery, rejected writes, completion rollback, JSON backup preview and legacy restore');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
