/* Daily reports are keyed by date and author. Drafts never enter the sync table. */
(() => {
  'use strict';

  const moduleTerms = [
    ['o02', /采购|库存|补货|供应商|样品到货/], ['o03', /物流|仓库|配送|履约/],
    ['o01', /质量|质检|认证|打样/], ['o04', /客服|售后|退款/],
    ['o05', /合规|申诉/], ['o06', /利润|财务|现金流/],
    ['m01', /调研|竞品/], ['m02', /定位|卖点/], ['m03', /上市|营销规划/],
    ['m04', /拍摄|主图|视频|素材|文案|标题/], ['m05', /商品页|店铺|促销/],
    ['m06', /独立站|落地页|SEO/i], ['m07', /社媒|社区/], ['m08', /达人|联盟/],
    ['m09', /广告|投放/], ['m10', /公关|媒体|展会/], ['m11', /复购|会员|邮件/],
    ['m12', /归因|复盘|追踪/],
  ];

  const prioritySignal = /优先|重点|紧急|卡住|阻塞|受阻|影响.{0,12}(排期|上线|拍摄|上市|交付)/;
  const completion = /已完成|已交付|已发布|已上线/;
  const localDate = stamp => new Date(stamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const nextDay = (date, delta) => {
    const day = new Date(date + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + delta);
    return day.toISOString().slice(0, 10);
  };

  function actionDay(action, date) {
    const exact = action.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (exact && Number.isFinite(Date.parse(exact[1])) && nextDay(exact[1], 0) === exact[1]) return exact[1];
    if (/明天|明日/.test(action)) return nextDay(date, 1);
    if (/后天/.test(action)) return nextDay(date, 2);
    if (/今天|今日/.test(action)) return date;
    return '';
  }

  function segments(text) {
    // Keep a blocker with its follow-up instruction, including the original punctuation.
    return text.split(/\n+/).flatMap(paragraph => {
      const entries = [];
      let pending = '';
      const sentences = paragraph.match(/[^。！？]+[。！？]?/g) || [];
      for (const sentence of sentences) {
        const value = sentence.trim();
        if (!value) continue;
        const problem = /未到|没到|延误|阻塞|卡住|受阻|影响/.test(value);
        const incoming = /^(?:[今明后]天|[今明]日|我|需要|下一步|优先|请)/.test(value);
        if (pending && incoming) {
          entries.push(pending + value);
          pending = '';
        } else {
          if (pending) entries.push(pending);
          pending = problem ? value : '';
          if (!problem) entries.push(value);
        }
      }
      if (pending) entries.push(pending);
      return entries;
    });
  }

  function propose(source, draft, ctx) {
    const { data, ui, uid } = ctx;
    const parts = source.replace(/[。！？；;]+$/, '').split(/[。！？；;]/);
    const action = parts.at(-1).trim();
    const instruction = action.replace(/^(?:今天|明天|后天|今日|明日)?(?:我会|我将|我)?(?:先|优先|重点)?/, '').trim();
    const coordination = instruction.match(/^(?:找|联系|跟|和)([^，。]{1,10}?)(确认|核对|沟通)(.{2,})$/);
    const title = (coordination ? coordination[2] + coordination[3] : instruction || action).slice(0, 100);
    const productMatches = data.products.filter(p => source.includes(p.name));
    let product = '';
    if (productMatches.length === 1) product = productMatches[0].id;
    if (!productMatches.length) product = data.products.find(p => p.id === ui.product)?.id || (data.products.length === 1 ? data.products[0].id : '');
    const tasks = data.tasks.filter(t => t.product === product && !t.dailyWork?.length);
    const matches = tasks.filter(t => t.title && action.includes(t.title));
    const match = matches.length === 1 ? matches[0] : null;
    const signal = source.match(prioritySignal)?.[0] || '';
    const dueSoon = match?.end && match.status !== '已完成' && !completion.test(action) && match.end <= nextDay(draft.date, 1);
    const reason = signal ? '原文提到“' + signal + '”' : dueSoon ? '关联任务临近截止或已逾期' : match?.priorityReason || '';
    const slot = actionDay(action, draft.date);
    const module = moduleTerms.find(([id, pattern]) => data.modules.some(m => m.id === id) && pattern.test(action))?.[0] || '';
    const idea = /想试|考虑|也许|或许|可以试/.test(action);
    const done = completion.test(action);
    const selfAssigned = /(?:我来|我会|我将|[今明后]天我|^我)/.test(action);
    const related = data.tasks.filter(t => t.product === product && t.id !== match?.id && t.title &&
      (source.includes('影响' + t.title) || parts.slice(0, -1).some(p => p.includes('影响') && p.includes(t.title))));
    return {
      id: 'i' + uid(), source, title: match?.title || title, product, module: match?.module || module,
      publish: !idea && Boolean(signal || slot || match),
      priority: Boolean(signal || dueSoon || match?.priority), reason, collaborator: coordination?.[1] || '',
      personId: match?.personId || (selfAssigned ? draft.personId : ''), actionDate: slot,
      taskId: match?.id || '', done, relatedTaskId: related.length === 1 ? related[0].id : '',
    };
  }

  function similarWording(first, second) {
    const normalize = text => text.replace(/[\s，。、；！？,.!?;]/g, '');
    const a = normalize(first), b = normalize(second);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = Math.min(a.length, b.length);
    let start = 0, end = 0;
    while (start < shorter && a[start] === b[start]) start++;
    while (start + end < shorter && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return start + end >= 6 && (start + end) / Math.max(a.length, b.length) >= 0.72;
  }

  function render(container, ctx) {
    const { data, ui, save, esc, uid } = ctx;
    data.reports ||= [];
    data.reportDrafts ||= [];
    const date = ui.reportDate || (ui.reportDate = localDate(Date.now()));
    const personId = ui.reportPerson || '';
    const same = row => row.date === date && row.personId === personId;
    const submitted = data.reports.find(same);
    let draft = data.reportDrafts.find(same) || {
      id: submitted?.id || 'r' + uid(), date, personId, text: submitted?.text || '',
      items: structuredClone(submitted?.items || []), previewText: null,
    };
    const completed = submitted?.completedSnapshot || ctx.leafItems(data.tasks)
      .filter(x => x.status === '已完成' && x.completedAt && localDate(x.completedAt) === date && x.personId === personId)
      .map(x => ({ key: x.key, title: x.title, product: x.task.product, completedAt: x.completedAt }));
    const personOptions = data.people.filter(p => p.active !== false || p.id === personId);
    const makeOptions = (list, value, blank) => [
      '<option value="">' + esc(blank) + '</option>',
      ...list.map(row => '<option value="' + esc(row.id) + '"' + (row.id === value ? ' selected' : '') + '>' + esc(row.name) + '</option>'),
    ].join('');
    const archived = Boolean(submitted && !data.reportDrafts.find(same));
    const statusText = archived ? '已提交日报' : (draft.updatedAt ? '草稿已保存到本机' : '');
    const completedList = completed.map(x => '<li>' + esc(x.title) + '</li>').join('');
    container.innerHTML = `
      <div class="mm-report-heading"><h2>日报</h2><div class="mm-report-selectors">
        <label>日报日期<input type="date" id="mm-report-date" value="${esc(date)}" required></label>
        <label>填写人<select id="mm-report-person">${makeOptions(personOptions, personId, '本机填写人')}</select></label>
      </div></div>
      <div class="mm-report-body">
        ${completed.length ? `<details class="mm-report-snapshot"><summary>当日已完成 · ${completed.length} 项</summary><ul>${completedList}</ul></details>` : ''}
        <label for="mm-report-text">工作记录</label>
        <textarea id="mm-report-text" rows="8" placeholder="写下进展与结果、阻塞与协助、明日安排…">${esc(draft.text)}</textarea>
        <div class="mm-report-actions"><button type="button" class="mm-primary" id="mm-report-preview">预览分发</button>
        <span id="mm-report-status" role="status">${esc(statusText)}</span>
        <button type="button" id="mm-report-retry" hidden>重试本机保存</button></div>
        <div id="mm-report-suggestions"></div>
      </div>`;
    const find = selector => container.querySelector(selector);
    const status = find('#mm-report-status');
    const retry = find('#mm-report-retry');

    function persist() {
      draft.updatedAt = new Date().toISOString();
      if (!data.reportDrafts.includes(draft)) data.reportDrafts.push(draft);
      const ok = save();
      window.projectState?.setDirty?.('report', !ok);
      retry.hidden = ok;
      status.textContent = ok ? '草稿已保存到本机 · ' + ctx.localStamp(draft.updatedAt).slice(11, 19) : '本机保存失败，输入仍在编辑器中。';
      return ok;
    }

    function changeIdentity() {
      const chosen = find('#mm-report-date').value;
      if (!chosen || (!retry.hidden && !persist())) {
        find('#mm-report-date').value = date;
        find('#mm-report-person').value = personId;
        return;
      }
      const selectedPerson = find('#mm-report-person').value;
      ui.reportDate = chosen;
      ui.reportPerson = selectedPerson;
      save();
      render(container, ctx);
    }

    function synchronizeSuggestions() {
      const old = [...draft.items];
      const sources = segments(draft.text);
      const items = sources.map(source => {
        const exact = old.findIndex(item => item.source === source);
        return exact >= 0 ? old.splice(exact, 1)[0] : null;
      });
      const edited = sources.filter((_, i) => !items[i]);
      for (const [index, source] of sources.entries()) {
        if (items[index]) continue;
        const fresh = propose(source, draft, ctx);
        const candidates = old.filter(item => similarWording(item.source, source));
        const previous = candidates.length === 1 ? candidates[0] : null;
        if (previous && edited.filter(s => similarWording(previous.source, s)).length === 1) {
          // Retain the explicit link and user choices after a small wording correction.
          const oldGuess = propose(previous.source, draft, ctx);
          const revised = {...previous, source};
          for (const field of ['personId','collaborator','module','priority','reason','done','actionDate','relatedTaskId']) {
            if (previous[field] === oldGuess[field]) revised[field] = fresh[field];
          }
          if (!previous.taskId && previous.title === oldGuess.title) revised.title = fresh.title;
          if (!fresh.product || (fresh.product !== previous.product && source.includes(data.products.find(p => p.id === fresh.product)?.name))) {
            revised.product = fresh.product;
            revised.taskId = '';
            revised.publish = false;
          }
          items[index] = revised;
        } else {
          // Changed, unmatched entries in a revision require an explicit decision to create another task.
          if (submitted && !fresh.taskId && old.some(item => item.taskId)) fresh.publish = false;
          items[index] = fresh;
        }
      }
      draft.items = items;
      draft.previewText = draft.text;
    }

    function card(item) {
      const targets = data.tasks.filter(t => t.product === item.product && !t.dailyWork?.length);
      const related = data.tasks.filter(t => t.product === item.product && t.id !== item.taskId);
      const taskList = rows => rows.map(t => ({ id: t.id, name: t.title + (t.owner ? ' · ' + t.owner : '') }));
      const target = targets.find(t => t.id === item.taskId);
      const destination = target ? '更新「' + target.title + '」' : '新建任务';
      return `<fieldset data-report-item="${esc(item.id)}" class="mm-report-item">
        <legend><label><input type="checkbox" data-field="publish" ${item.publish ? 'checked' : ''}>纳入工作安排</label></legend>
        <p class="mm-report-quote">${esc(item.source)}</p>
        <div class="mm-form-grid">
          <label>任务名称<input data-field="title" maxlength="100" value="${esc(item.title)}"></label>
          <label>行动日期<input type="date" data-field="actionDate" value="${esc(item.actionDate)}"></label>
          <label>负责人<select data-field="personId">${makeOptions(data.people, item.personId, '待确认')}</select></label>
          <label>业务板块<select data-field="module">${makeOptions(data.modules, item.module, '待归类')}</select></label>
        </div>
        <details class="mm-report-routing" ${!item.product ? 'open' : ''}>
          <summary>${esc(item.product ? destination : '请选择所属产品')} · 关联与协作</summary>
          <div class="mm-form-grid">
          <label>产品<select data-field="product">${makeOptions(data.products, item.product, '选择产品')}</select></label>
          <label>协作方<input data-field="collaborator" maxlength="80" value="${esc(item.collaborator || '')}"></label>
          <label>更新任务<select data-field="taskId">${makeOptions(taskList(targets), item.taskId, '新建任务')}</select></label>
          <label>关联排期<select data-field="relatedTaskId">${makeOptions(taskList(related), item.relatedTaskId, '无')}</select></label>
        </div></details>
        <div class="mm-report-flags">
          <label><input type="checkbox" data-field="priority" ${item.priority ? 'checked' : ''}>工作重点</label>
          <label><input type="checkbox" data-field="done" ${item.done ? 'checked' : ''}>已完成</label>
          ${item.priority && item.reason ? '<span>' + esc(item.reason) + '</span>' : ''}
        </div></fieldset>`;
    }

    function drawPreview() {
      const area = find('#mm-report-suggestions');
      if (draft.previewText !== draft.text || !draft.text.trim()) { area.replaceChildren(); return; }
      const expanded = new Set(Array.from(area.querySelectorAll('details[open]'), details => details.closest('[data-report-item]').dataset.reportItem));
      area.innerHTML = '<h3>确认分发</h3><p class="mm-label">勾选的事项将更新任务，其余内容仅保存在日报。关联排期保留原日期。</p>' +
        draft.items.map(card).join('') +
        '<button type="button" class="mm-primary" id="mm-report-submit">确认提交日报</button>';
      for (const row of area.querySelectorAll('[data-report-item]')) {
        if (expanded.has(row.dataset.reportItem)) row.querySelector('details').open = true;
      }
      area.oninput = event => {
        const field = event.target.dataset.field;
        const item = draft.items.find(row => row.id === event.target.closest('[data-report-item]')?.dataset.reportItem);
        if (!field || !item) return;
        item[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        if (field === 'product') { item.taskId = ''; item.relatedTaskId = ''; }
        if (field === 'taskId') {
          const selected = data.tasks.find(t => t.id === item.taskId);
          if (selected) {
            item.title = selected.title;
            item.personId = selected.personId || item.personId;
            item.module = selected.module || item.module;
            if (item.relatedTaskId === selected.id) item.relatedTaskId = '';
          }
        }
        if (field === 'priority') item.reason = item.priority ? '手动标记重点' : '';
        persist();
        if (['product','taskId','priority'].includes(field)) drawPreview();
      };
      find('#mm-report-submit').onclick = submit;
    }

    function submit() {
      if (!draft.text.trim() || draft.text !== draft.previewText) return;
      const items = structuredClone(draft.items);
      const nextTasks = [...data.tasks];
      const assigned = new Set();
      const reportTaskIds = [];
      for (const item of items.filter(row => row.publish)) {
        if (!item.title.trim() || !data.products.some(p => p.id === item.product)) {
          status.textContent = '请为纳入安排的事项填写名称并选择产品。';
          return;
        }
        const previous = item.taskId ? data.tasks.find(t => t.id === item.taskId) : null;
        if (item.taskId && (!previous || previous.dailyWork?.length || previous.product !== item.product)) {
          status.textContent = '关联任务已变更，请重新选择任务。';
          return;
        }
        if (previous && assigned.has(previous.id)) {
          status.textContent = '两条事项指向同一个任务，请合并或仅保留一条。';
          return;
        }
        const task = previous ? structuredClone(previous) : ctx.taskDefaults({
          id: 't' + uid(), product: item.product, phase: 0, lane: data.lanes[0]?.id || '',
          market: '', start: item.actionDate, end: item.actionDate,
        });
        const prior = submitted?.items.find(row => row.id === item.id && row.publish && row.taskId === task.id);
        const changed = key => !prior || prior[key] !== item[key];
        if (changed('title')) task.title = item.title.trim();
        if (changed('personId') && (item.personId || prior)) {
          const person = data.people.find(p => p.id === item.personId);
          task.personId = person?.id || '';
          task.owner = person?.name || '';
          task.role = person?.role || '';
        }
        if (changed('collaborator') && (item.collaborator || prior)) task.collaborator = item.collaborator;
        if (changed('module') && (item.module || prior || !previous)) task.module = item.module;
        if (changed('priority')) task.priority = item.priority;
        if (changed('reason')) task.priorityReason = item.reason;
        if (changed('actionDate') && (item.actionDate || prior)) task.actionDate = item.actionDate;
        if (changed('done') && (item.done || prior?.done)) ctx.applyDone(task, item.done);
        if (changed('relatedTaskId') && (item.relatedTaskId || prior)) task.relatedTaskId = item.relatedTaskId;
        task.sourceReportIds = [...new Set([...(task.sourceReportIds || []), draft.id])];
        item.taskId = task.id;
        assigned.add(task.id);
        reportTaskIds.push(task.id);
        if (previous) nextTasks[nextTasks.indexOf(previous)] = task;
        else nextTasks.push(task);
      }
      // Commit report, confirmed task edits and draft removal in one local-state write.
      const now = new Date().toISOString();
      const record = { id: draft.id, date, personId, text: draft.text, items, completedSnapshot: structuredClone(completed), submittedAt: now };
      const old = { reports: data.reports, tasks: data.tasks, reportDrafts: data.reportDrafts };
      data.tasks = nextTasks;
      data.reports = [...data.reports.filter(r => r.id !== record.id), record];
      data.reportDrafts = data.reportDrafts.filter(r => r.id !== record.id);
      if (!save()) {
        Object.assign(data, old);
        status.textContent = '日报提交失败，草稿和分发选择已保留。请重试。';
        window.projectState?.setDirty?.('report', true);
        retry.hidden = false;
        return;
      }
      window.projectState?.setDirty?.('report', false);
      document.dispatchEvent(new CustomEvent('dashboard-report-submitted', { detail: { reportId: record.id, taskIds: reportTaskIds } }));
      render(container, ctx);
    }

    retry.onclick = persist;
    find('#mm-report-date').onchange = changeIdentity;
    find('#mm-report-person').onchange = changeIdentity;
    find('#mm-report-text').oninput = event => {
      draft.text = event.target.value;
      draft.previewText = null;
      drawPreview();
      persist();
    };
    find('#mm-report-preview').onclick = () => {
      if (!draft.text.trim()) { status.textContent = '请先填写工作记录。'; find('#mm-report-text').focus(); return; }
      synchronizeSuggestions();
      persist();
      drawPreview();
    };
    drawPreview();
  }

  window.addEventListener('dashboard-saved', () => window.projectState?.setDirty?.('report', false));
  window.dashboardReports = Object.freeze({ render });
})();
