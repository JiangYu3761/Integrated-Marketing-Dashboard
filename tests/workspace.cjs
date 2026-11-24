// Exercise the public workspace flows in an isolated browser context.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    // In Shanghai it is already December 31. Tomorrow crosses a calendar year.
    await page.clock.setFixedTime(new Date('2026-12-30T17:00:00Z'));
    await page.goto(process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:8877/');

    const panel = name => page.locator('#mm-view-' + name);
    const tab = name => page.locator('#mm-tab-' + name);
    const state = () => page.evaluate(() => window.projectState.read()?.privateContent?.data);
    const openNested = async (menu, name) => {
      if (!(await tab(name).isVisible())) await page.locator('#mm-' + menu + '-menu summary').click();
      await tab(name).click();
      assert(await panel(name).isVisible(), name + ' panel should open');
    };

    assert(await panel('calendar').isVisible(), 'fresh installation should open the calendar');
    for (const name of ['calendar', 'report', 'time', 'feishu']) assert(await tab(name).isVisible());
    for (const name of ['marketing', 'ceo', 'map', 'table']) await openNested('product', name);
    for (const name of ['projects', 'people']) await openNested('admin', name);
    await page.locator('#mm-person-add').click();
    await page.locator('#mm-person-form [name=name]').fill('日报测试员');
    await page.locator('#mm-person-save').click();
    const [person] = (await state()).people;

    await tab('calendar').click();
    const selectedDate = () => panel('calendar').locator('[data-cal-date][aria-pressed=true]').getAttribute('data-cal-date');
    assert.equal(await selectedDate(), '2026-12-31');
    await page.locator('[data-cal-next]').click();
    assert.equal(await selectedDate(), '2027-01-31');
    await page.locator('[data-cal-prev]').click();
    assert.equal(await selectedDate(), '2026-12-31');
    await page.locator('.cal-grid').dispatchEvent('wheel', { deltaX: 120, deltaY: 1 });
    assert.equal(await selectedDate(), '2027-01-31');
    await page.locator('[data-cal-today]').click();
    assert.equal(await selectedDate(), '2026-12-31');
    await page.locator('[data-cal-report]').click();
    await page.locator('#mm-report-person').selectOption(person.id);
    assert.equal(await page.locator('#mm-report-date').inputValue(), '2026-12-31');
    const reportText = '明天我优先找采购确认样品到货时间';
    await page.locator('#mm-report-text').fill(reportText);
    await page.reload();
    await tab('report').click();
    await page.locator('#mm-report-person').selectOption(person.id);
    assert.equal(await page.locator('#mm-report-text').inputValue(), reportText);
    assert.equal((await state()).tasks.length, 0, 'a local draft must not create a task');

    await page.locator('#mm-report-preview').click();
    const suggestion = page.locator('[data-report-item]').first();
    assert(await suggestion.locator('[data-field=priority]').isChecked());
    assert.equal(await suggestion.locator('[data-field=actionDate]').inputValue(), '2027-01-01');
    assert.equal((await state()).tasks.length, 0, 'a preview must not publish a task');
    await suggestion.locator('[data-field=title]').fill('跟进样品到货');
    await suggestion.locator('[data-field=personId]').selectOption(person.id);
    await page.locator('#mm-report-submit').click();
    let tasks = (await state()).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, '跟进样品到货');
    assert.equal(tasks[0].personId, person.id);
    const taskId = tasks[0].id;

    await tab('calendar').click();
    await page.locator('[data-cal-next]').click();
    await page.locator('[data-cal-date="2027-01-01"]').click();
    assert((await page.locator('.cal-agenda').innerText()).includes(tasks[0].title));
    assert.equal(await page.locator('[data-cal-pin]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-cal-check]').check();
    assert.equal((await state()).tasks[0].status, '已完成');

    await tab('feishu').click();
    const master = page.locator('[data-feishu-table]');
    const row = master.locator('tr[data-feishu-id="task:' + taskId + '"]');
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert((await row.innerText()).includes(tasks[0].title));
    assert.equal(await master.locator('tr[data-feishu-id^="report:"]').count(), 1);
    assert(!(await row.locator('[data-feishu-status]').innerText()).includes('已同步'), 'a static browser has no Feishu connection');

    await page.locator('[data-feishu-filter=state]').selectOption('已提交');
    await row.waitFor({ state: 'hidden' });
    assert.equal(await master.locator('tr[data-feishu-id^="report:"]').count(), 1);
    await page.locator('[data-feishu-clear]').click();
    await row.locator('[data-feishu-report]').click();
    await page.reload();
    assert(await panel('report').isVisible(), 'the source report should reopen in the same window');
    assert.equal(await page.locator('#mm-report-person').inputValue(), person.id);
    assert.equal(await page.locator('#mm-report-text').inputValue(), reportText);
    await page.locator('#mm-report-preview').click();
    await page.locator('#mm-report-submit').click();
    tasks = (await state()).tasks;
    assert.deepEqual(tasks.map(t => t.id), [taskId], 'resubmitting the same report must reuse its task ID');
    assert.equal(tasks[0].status, '已完成', 'a later calendar edit must survive resubmission');
    await tab('feishu').click();
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.equal(await master.locator('tr[data-feishu-id^="report:"]').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const name of ['calendar', 'report', 'time', 'feishu']) {
      await tab(name).click();
      assert(await panel(name).isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' overflows the window');
    }
    assert.equal(context.pages().length, 1, 'business flows stay in the same window');
    assert.deepEqual(errors, []);
    console.log('PASS: navigation, report draft recovery, priority preview, submission and Feishu master deduplication');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
