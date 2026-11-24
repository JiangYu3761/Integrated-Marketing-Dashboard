/* Month planner. All task edits go through the same records as the timeline. */
(() => {
  'use strict';

  const DAY = 86400000;
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const gestures = new WeakMap();
  const iso = date => date.toISOString().slice(0, 10);
  const utc = date => new Date(date + 'T00:00:00Z');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function shanghaiToday() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function shiftMonth(date, offset) {
    const next = utc(date);
    const day = next.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + offset, 1);
    const last = new Date(next);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    next.setUTCDate(Math.min(day, last.getUTCDate()));
    return iso(next);
  }

  function monthDates(selected) {
    const first = utc(selected.slice(0, 7) + '-01');
    const last = new Date(first);
    last.setUTCMonth(first.getUTCMonth() + 1, 0);
    const offset = (first.getUTCDay() + 6) % 7; // Weeks start on Monday.
    const count = Math.ceil((offset + last.getUTCDate()) / 7) * 7;
    return Array.from({ length: count }, (_, i) => iso(new Date(+first + (i - offset) * DAY)));
  }

  function scheduled(item, date) {
    const record = item.entry || item.task;
    if (record.actionDate === date) return true;
    const start = item.start || item.end;
    const end = item.end || item.start;
    return !!start && start <= date && date <= end;
  }

  function priorityOn(item, date) {
    const record = item.entry || item.task;
    return record.priority === true && (!record.actionDate || date === record.actionDate);
  }

  function cellMarkup(date, entries, selected, today) {
    const priorities = entries.filter(item => priorityOn(item, date));
    const preview = priorities.slice(0, 2);
    const more = entries.length - preview.length;
    const outside = date.slice(0, 7) !== selected.slice(0, 7);
    return `<button type="button" class="cal-date" data-cal-date="${date}"
      aria-label="${date}，${entries.length} 项工作，${priorities.length} 项重点"
      aria-pressed="${date === selected}" tabindex="${date === selected ? 0 : -1}"
      ${outside ? 'data-other-month' : ''} ${date === today ? 'aria-current="date"' : ''}>
      <span class="cal-number">${Number(date.slice(-2))}</span>
      ${preview.map(item => `<span class="cal-preview ${item.status === '已完成' ? 'cal-complete' : ''}">${escape(item.title)}</span>`).join('')}
      ${more ? `<span class="cal-count">${preview.length ? '还有 ' : ''}${more} 项</span>` : ''}
    </button>`;
  }

  function agendaRow(item, index, date, today, projectWide, productNames, reports) {
    const record = item.entry || item.task;
    const done = item.status === '已完成';
    const sources = (item.task.sourceReportIds || []).map(id => reports.get(id)).filter(Boolean);
    const flags = [];
    if (priorityOn(item, date)) flags.push('重点');
    if (!done && item.end && item.end < today && item.end < date) flags.push('已逾期 ' + item.end.slice(5));
    else if (item.end === date) flags.push('当天到期');
    if (projectWide) flags.push(productNames.get(item.task.product) || '');
    flags.push(item.owner || '未分配');
    return `<li class="cal-row ${done ? 'cal-complete' : ''}">
      <input type="checkbox" data-cal-check="${index}" aria-label="完成：${escape(item.title)}" ${done ? 'checked' : ''}>
      <div class="cal-item">
        <button type="button" class="cal-task" data-cal-edit="${index}">${escape(item.title)}</button>
        <small>${escape(flags.filter(Boolean).join(' · '))}</small>
        ${sources.map(report => `<button type="button" class="cal-source" data-cal-source="${escape(report.id)}">来源日报 · ${escape(report.date)}</button>`).join('')}
      </div>
      <button type="button" class="cal-pin" data-cal-pin="${index}" aria-pressed="${record.priority === true}"
        aria-label="${record.priority ? '取消重点' : '标为重点'}：${escape(item.title)}" title="${record.priority ? '取消重点' : '标为重点'}">${record.priority ? '★' : '☆'}</button>
    </li>`;
  }

  function bindPaging(grid, host, turnMonth) {
    // Retain the lock across redraws so trackpad inertia never skips the next month.
    const wheel = gestures.get(host) || { distance: 0, last: 0, moved: false };
    gestures.set(host, wheel);
    grid.addEventListener('wheel', event => {
      if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      if (now - wheel.last > 200) {
        wheel.distance = 0;
        wheel.moved = false;
      }
      wheel.last = now;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? grid.clientWidth : 1;
      wheel.distance += event.deltaX * unit;
      if (!wheel.moved && Math.abs(wheel.distance) >= 56) {
        wheel.moved = true;
        turnMonth(Math.sign(wheel.distance));
      }
    }, { passive: false });
    let touch = null;
    grid.addEventListener('touchstart', event => {
      touch = event.touches.length === 1 ? event.touches[0] : null;
    }, { passive: true });
    grid.addEventListener('touchcancel', () => { touch = null; });
    grid.addEventListener('touchend', event => {
      if (!touch || event.touches.length) return;
      const end = event.changedTouches[0];
      const dx = end.clientX - touch.clientX;
      const dy = end.clientY - touch.clientY;
      touch = null;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        if (event.cancelable) event.preventDefault();
        turnMonth(-Math.sign(dx));
      }
    }, { passive: false });
  }

  function render(host, ctx) {
    const { data, ui } = ctx;
    const today = shanghaiToday();
    const selected = /^\d{4}-\d{2}-\d{2}$/.test(ui.day || '') && Number.isFinite(+utc(ui.day)) ? ui.day : today;
    const allItems = ctx.leafItems(ctx.visible());
    const projects = new Set(data.products.filter(product => ui.product === '*' ?
      !ui.project || product.projectId === ui.project : product.id === ui.product).map(product => product.projectId));
    const assigned = new Set(allItems.map(item => item.personId));
    const people = data.people.filter(person => assigned.has(person.id) ||
      person.active !== false && person.projectIds.some(id => projects.has(id)));
    const personId = people.some(person => person.id === ui.dayPerson) ? ui.dayPerson : '';
    const items = personId ? allItems.filter(item => item.personId === personId) : allItems;
    const dates = monthDates(selected);
    const displayed = new Map(dates.map(date => [date, items.filter(item => scheduled(item, date))]));
    const onDay = displayed.get(selected);
    const overdue = items.filter(item => item.status !== '已完成' && item.end &&
      item.end < today && item.end < selected && !scheduled(item, selected));
    const agenda = [...onDay].sort((a, b) => Number(priorityOn(b, selected)) - Number(priorityOn(a, selected)) ||
      Number(a.status === '已完成') - Number(b.status === '已完成')).concat(overdue);
    const productNames = new Map(data.products.map(product => [product.id, product.name]));
    const day = utc(selected);
    const label = `${day.getUTCMonth() + 1}月${day.getUTCDate()}日 周${weekdays[(day.getUTCDay() + 6) % 7]}`;
    const reports = new Map((data.reports || []).map(report => [report.id, report]));
    const row = (item, index) => agendaRow(item, index, selected, today, ui.product === '*', productNames, reports);
    host.innerHTML = `<div class="cal-layout">
      <section class="cal-month" aria-label="工作月历">
        <div class="cal-toolbar"><h2>${day.getUTCFullYear()}年 ${day.getUTCMonth() + 1}月</h2>
          <div class="cal-controls"><button type="button" data-cal-prev aria-label="上个月">‹</button>
          <button type="button" data-cal-today>今天</button>
          <button type="button" data-cal-next aria-label="下个月">›</button></div>
        </div>
        <div class="cal-days"><div class="cal-weekdays" aria-hidden="true">${weekdays.map(w => `<span>周${w}</span>`).join('')}</div>
          <div class="cal-grid" role="group" aria-label="选择日期">${dates.map(date => cellMarkup(date, displayed.get(date), selected, today)).join('')}</div>
        </div>
      </section>
      <section class="cal-agenda" aria-label="选中日期的工作">
        <h2>${label}</h2>
        <select aria-label="日历负责人" data-cal-person><option value="">全部负责人</option>${people.map(person =>
          `<option value="${escape(person.id)}" ${person.id === personId ? 'selected' : ''}>${escape(person.name + (person.code ? ' · ' + person.code : ''))}</option>`).join('')}</select>
        <div class="cal-actions"><button type="button" class="mm-primary" data-cal-add ${projects.size ? '' : 'disabled'}>＋ 添加任务</button>
          <button type="button" data-cal-report>写当日日报</button></div>
        <h3>当日任务 <span>${onDay.length}</span></h3>
        ${onDay.length ? `<ul>${agenda.slice(0, onDay.length).map(row).join('')}</ul>` : '<p class="cal-empty">当天暂无任务</p>'}
        ${overdue.length ? `<details class="cal-overdue"><summary>逾期未完成（${overdue.length}）</summary><ul>${overdue.map((item, i) => row(item, i + onDay.length)).join('')}</ul></details>` : ''}
      </section>
    </div>`;
    const selectDate = (date, focusSelector) => {
      ui.day = date;
      ctx.save();
      render(host, ctx);
      if (focusSelector) host.querySelector(focusSelector)?.focus({ preventScroll: true });
    };
    const turnMonth = (offset, focusSelector) => selectDate(shiftMonth(selected, offset), focusSelector);
    host.querySelector('[data-cal-prev]').onclick = () => turnMonth(-1, '[data-cal-prev]');
    host.querySelector('[data-cal-next]').onclick = () => turnMonth(1, '[data-cal-next]');
    host.querySelector('[data-cal-today]').onclick = () => selectDate(today, '[data-cal-today]');
    host.querySelector('[data-cal-person]').onchange = event => {
      ui.dayPerson = event.target.value;
      ctx.save();
      render(host, ctx);
      host.querySelector('[data-cal-person]').focus();
    };
    const grid = host.querySelector('.cal-grid');
    grid.onclick = event => {
      const button = event.target.closest('[data-cal-date]');
      if (button) selectDate(button.dataset.calDate, '[aria-pressed=true].cal-date');
    };
    grid.onkeydown = event => {
      const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
      if (!offset || !event.target.matches('[data-cal-date]')) return;
      event.preventDefault();
      selectDate(iso(new Date(+utc(event.target.dataset.calDate) + offset * DAY)), '[aria-pressed=true].cal-date');
    };
    bindPaging(grid, host, turnMonth);
    host.querySelector('[data-cal-report]').onclick = () => ctx.openReport(selected, personId);
    host.querySelector('[data-cal-add]').onclick = () => {
      const owner = people.find(person => person.id === personId);
      ctx.openTask(null, { start: selected, end: selected, personId, role: owner?.role || ui.role || '' });
    };
    const panel = host.querySelector('.cal-agenda');
    panel.onchange = event => {
      if (!event.target.matches('[data-cal-check]')) return;
      const item = agenda[Number(event.target.dataset.calCheck)];
      ctx.toggleTask(item.task.id, event.target.checked, item.entry?.id || '');
    };
    panel.onclick = event => {
      const source = event.target.closest('[data-cal-source]');
      if (source) {
        const report = reports.get(source.dataset.calSource);
        if (report) ctx.openReport(report.date, report.personId);
        return;
      }
      const button = event.target.closest('[data-cal-edit], [data-cal-pin]');
      if (!button) return;
      const item = agenda[Number(button.dataset.calEdit ?? button.dataset.calPin)];
      if (button.hasAttribute('data-cal-edit')) {
        ctx.openTask(item.task.id, item.entry ? { focusDaily: item.entry.id } : {});
        return;
      }
      const task = data.tasks.find(task => task.id === item.task.id);
      const record = item.entry ? task?.dailyWork?.find(child => child.id === item.entry.id) : task;
      if (!record) return;
      const previous = record.priority;
      record.priority = !record.priority;
      if (ctx.save() === false) {
        if (previous === undefined) delete record.priority;
        else record.priority = previous;
        return;
      }
      render(host, ctx);
    };
  }

  window.dashboardCalendar = Object.freeze({ render });
})();
