// Requires Playwright and Chromium in the development environment. No app dependencies.
// Start a static server, then run: DASHBOARD_TEST_URL=http://127.0.0.1:8877/ node tests/day-view.cjs
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const state = () => page.evaluate(() => window.projectState.read()?.privateContent);
  const cellFor = (date, person) => page.locator(`[data-day-date="${date}"][data-day-person="${person}"][data-day-product="p1"]`);
  const lineFor = (date, person, key) => cellFor(date, person).locator(`[data-day-item="${key}"]`);
  const report = message => console.log('PASS: ' + message);
  const openBlank = async cell => {
    const box = await cell.boundingBox();
    await cell.dblclick({ position: { x: box.width - 12, y: box.height - 12 } });
    assert(await page.locator('#mm-task-dialog').isVisible());
  };

  try {
    await page.goto(process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:8877/', { waitUntil: 'networkidle' });
    await page.locator('#mm-tab-people').click();
    for (const name of ['测试人员甲', '测试人员乙']) {
      await page.locator('#mm-person-add').click();
      await page.locator('#mm-person-form [name=name]').fill(name);
      await page.locator('#mm-person-save').click();
    }
    const [person, second] = (await state()).data.people;
    await page.locator('#mm-tab-time').click();
    await page.locator('#mm-role-filter').selectOption(person.role);
    await page.locator('[data-time-scale=day]').click();
    await page.locator('#mm-focus-day').fill('2026-11-01');
    await page.locator('#mm-focus-day').dispatchEvent('change');
    assert.equal(await page.locator('[data-select-day="2026-11-01"]').textContent(), '1日');

    for (let i = 1; i <= 8; i++) {
      await openBlank(cellFor('2026-11-01', person.id));
      assert.equal(await page.locator('#mm-task-form [name=personId]').inputValue(), person.id);
      assert.equal(await page.locator('#mm-task-form [name=startAt]').inputValue(), '2026-11-01T09:00');
      assert.equal(await page.locator('#mm-task-form [name=endAt]').inputValue(), '2026-11-01T18:00');
      for (const name of ['title', 'personId', 'startAt', 'endAt', 'completedAt', 'notes']) {
        assert(await page.locator(`#mm-task-form [name=${name}]`).isVisible(), name);
      }
      for (const name of ['role', 'status', 'product', 'module', 'phase', 'delivery']) {
        assert(!(await page.locator(`#mm-task-form [name=${name}]`).isVisible()), name + ' should be folded');
      }
      await page.locator('#mm-task-form [name=title]').fill('资源对接：某某团队 ' + i);
      await page.locator('#mm-save-task').click();
    }
    const tasks = (await state()).data.tasks;
    assert.equal(tasks.length, 8);
    assert.equal(await cellFor('2026-11-01', person.id).locator('.mm-day-task').count(), 8);
    assert.equal(await cellFor('2026-11-01', second.id).locator('.mm-day-task').count(), 0);
    const geometry = await cellFor('2026-11-01', person.id).evaluate(cell => {
      const bounds = cell.getBoundingClientRect();
      const rows = [...cell.querySelectorAll('.mm-day-task')].map(row => row.getBoundingClientRect());
      return { width: bounds.width, contained: rows.every(row => row.top >= bounds.top && row.bottom <= bounds.bottom), ordered: rows.every((row, i) => !i || row.top >= rows[i - 1].bottom - 0.5) };
    });
    assert(geometry.width >= 240 && geometry.contained && geometry.ordered, 'eight tasks must fit as separate readable lines');
    report('eight stacked day tasks, correct date/owner defaults, simple editor with folded details');

    const first = tasks[0];
    const before = Date.now();
    await lineFor('2026-11-01', person.id, first.id).locator('input').check();
    let saved = (await state()).data.tasks[0];
    assert.equal(saved.status, '已完成');
    assert(Date.parse(saved.completedAt) >= before && Date.parse(saved.completedAt) <= Date.now());
    assert(await lineFor('2026-11-01', person.id, first.id).evaluate(row => row.classList.contains('mm-done')));
    assert((await lineFor('2026-11-01', person.id, first.id).locator('button').evaluate(button => getComputedStyle(button).textDecorationLine)).includes('line-through'));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal((await state()).data.tasks[0].completedAt, saved.completedAt);
    await lineFor('2026-11-01', person.id, first.id).locator('input').uncheck();
    saved = (await state()).data.tasks[0];
    assert.equal(saved.completedAt, '');
    assert.equal(saved.status, '待开始');
    await lineFor('2026-11-01', person.id, first.id).locator('button').click();
    await page.locator('#mm-task-form [name=completedAt]').fill('2026-11-01T12:30');
    await page.locator('#mm-task-form [name=completedAt]').dispatchEvent('change');
    await page.locator('#mm-save-task').click();
    assert.equal((await state()).data.tasks[0].completedAt, '2026-11-01T04:30:00.000Z');
    assert((await lineFor('2026-11-01', person.id, first.id).getAttribute('title')).includes('2026-11-01 12:30:00'));
    report('one-click strike-through, automatic ISO timestamp, undo, manual Shanghai time, reload persistence');

    if (process.env.DAY_VIEW_SCREENSHOT) await page.locator('#mm-view-time').screenshot({ path: process.env.DAY_VIEW_SCREENSHOT });
    await cellFor('2026-11-02', person.id).focus();
    await cellFor('2026-11-02', person.id).press('Enter');
    assert.equal(await page.locator('#mm-task-form [name=startAt]').inputValue(), '2026-11-02T09:00');
    await page.locator('#mm-cancel-task').click();
    assert.equal((await state()).data.tasks.length, 8, 'cancel must not save an empty task');

    await cellFor('2026-11-02', person.id).locator('[data-day-add]').click();
    await page.locator('#mm-task-form [name=title]').fill('跨日对接');
    await page.locator('#mm-task-form [name=startAt]').fill('2026-11-01T09:00');
    await page.locator('#mm-task-form [name=endAt]').fill('2026-11-03T18:00');
    await page.locator('#mm-save-task').click();
    const spanning = (await state()).data.tasks.at(-1);
    assert.equal(await lineFor('2026-11-01', person.id, spanning.id).count(), 1);
    assert.equal(await lineFor('2026-11-03', person.id, spanning.id).count(), 1);
    await lineFor('2026-11-02', person.id, spanning.id).locator('input').check();
    assert(await lineFor('2026-11-01', person.id, spanning.id).locator('input').isChecked());
    assert(await lineFor('2026-11-03', person.id, spanning.id).locator('input').isChecked());
    report('keyboard and explicit add entry; cross-day occurrences share one completion record');

    await openBlank(cellFor('2026-11-01', person.id));
    await page.locator('#mm-task-form [name=title]').fill('含每日子任务的父任务');
    await page.locator('summary').filter({ hasText: /^每日子任务$/ }).click();
    for (let i = 0; i < 2; i++) {
      await page.locator('#mm-add-daily').click();
      const row = page.locator('[data-daily-id]').nth(i);
      await row.locator('[data-child-key=title]').fill('分工对接 ' + (i + 1));
      await row.locator('[data-child-key=personId]').selectOption(i ? second.id : person.id);
    }
    await page.locator('#mm-save-task').click();
    const parent = (await state()).data.tasks.at(-1);
    assert.equal(await cellFor('2026-11-01', person.id).locator(`[data-day-item="${parent.id}"]`).count(), 0, 'do not repeat parent alongside leaf tasks');
    assert.equal(await lineFor('2026-11-01', person.id, parent.id + '/' + parent.dailyWork[0].id).count(), 1);
    const secondLine = lineFor('2026-11-01', second.id, parent.id + '/' + parent.dailyWork[1].id);
    await page.locator('#mm-timeline-pane').evaluate(pane => { pane.scrollTop = 70; });
    await secondLine.locator('input').scrollIntoViewIfNeeded();
    const scrollBefore = await page.locator('#mm-timeline-pane').evaluate(pane => pane.scrollTop);
    assert(scrollBefore > 0, 'exercise completion while vertically scrolled');
    await secondLine.locator('input').check();
    assert.equal((await state()).data.tasks.at(-1).dailyWork[1].status, '已完成');
    assert.equal((await state()).data.tasks.at(-1).status, '待开始');
    assert.equal(await page.locator('#mm-timeline-pane').evaluate(pane => pane.scrollTop), scrollBefore, 'completion should retain the current vertical position');
    report('daily children stay with their owners and are counted without duplicating the parent');

    await page.locator('#mm-focus-day').fill('2026-11-20');
    await page.locator('#mm-focus-day').dispatchEvent('change');
    await openBlank(cellFor('2026-11-20', person.id));
    assert.equal(await page.locator('#mm-task-form [name=startAt]').inputValue(), '2026-11-20T09:00');
    await page.locator('#mm-cancel-task').click();
    for (const scale of ['week', 'month', 'day']) {
      await page.locator(`[data-time-scale=${scale}]`).click();
      assert.equal(await page.locator('.mm-timeline-canvas').getAttribute('data-time-level'), scale);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mm-day-add').click();
    const modal = await page.locator('#mm-task-dialog').boundingBox();
    assert(modal.x >= 0 && modal.x + modal.width <= 390);
    await page.locator('#mm-cancel-task').click();
    assert.deepEqual(errors, []);
    report('scrolled date cells, month/week/day switching and narrow-screen dialog, no JavaScript exceptions');
  } finally {
    // Only this non-persistent context contains test records.
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
