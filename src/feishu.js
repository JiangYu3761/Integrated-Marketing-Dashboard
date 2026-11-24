(() => {
  'use strict';
  const fieldNames = ['本地ID','类型','事项','项目','产品','负责人','行动日','截止日','状态','重点','重点原因','板块','来源日报','内容'];
  const native = () => location.hostname === '127.0.0.1' && Boolean(window.webkit?.messageHandlers?.desktopUpdates);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const filters = {project:'', product:'', person:'', date:'', state:'', sync:''};
  let connection = null, statusRequest = null, active = null, processing = null, pending = null;
  let lastError = '';
  const working = new Set(), attempted = new Map();
  let cacheTimer = 0;

  function rowsFor(data) {
    const reports = (data.reports || []).filter(report => report.submittedAt);
    const people = new Map(data.people.map(p => [p.id, p.name]));
    const products = new Map(data.products.map(p => [p.id, p]));
    const projects = new Map(data.projects.map(p => [p.id, p.name]));
    const modules = new Map(data.modules.map(m => [m.id, m.name]));
    const sourceReports = new Map();
    for (const report of reports) {
      for (const item of report.items || []) {
        if (!item.taskId || !item.publish) continue;
        const linked = sourceReports.get(item.taskId) || [];
        if (!linked.includes(report)) linked.push(report);
        sourceReports.set(item.taskId, linked);
      }
    }
    function make(key, values, detail) {
      const fields = Object.fromEntries(fieldNames.map((name, i) => [name, String(values[i] ?? '')]));
      return {key, fields, ...detail};
    }
    const tasks = data.tasks.map(t => {
      const product = products.get(t.product);
      const linked = sourceReports.get(t.id) || [];
      const owner = people.get(t.personId) || t.owner || '';
      return make('task:' + t.id, ['task:' + t.id,'任务', t.title, projects.get(product?.projectId), product?.name, owner,
        t.actionDate || t.start, t.end, t.status, t.priority ? '是' : '否', t.priorityReason, modules.get(t.module),
        linked.map(report => report.id).join('、'), t.notes], {task:t, reports:linked, eligible:linked.length > 0, projectIds:[product?.projectId], productIds:[t.product], personId:t.personId || ''});
    });
    for (const report of reports) {
      const confirmed = (report.items || []).filter(item => item.taskId && item.publish !== false);
      const productIds = [...new Set(confirmed.map(item => item.product).filter(id => products.has(id)))];
      const projectIds = [...new Set(productIds.map(id => products.get(id).projectId))];
      const owner = people.get(report.personId) || '本机填写人';
      const completed = (report.completedSnapshot || []).map(entry => '• ' + entry.title);
      const content = completed.length ? [report.text, '当天已完成', ...completed].join('\n') : report.text;
      tasks.push(make('report:' + report.id, ['report:' + report.id, '日报', report.date + ' ' + (owner || '') + '日报', projectIds.map(id => projects.get(id)).join('、'),
        productIds.map(id => products.get(id).name).join('、'), owner, report.date, '', '已提交', '', '', '', report.id, content],
        {reports:[report], eligible:true, projectIds, productIds, personId:report.personId || ''}));
    }
    return tasks;
  }

  async function api(action, payload = {}) {
    const response = await fetch('/_desktop/feishu/' + action, {
      method:'POST', credentials:'same-origin', cache:'no-store',
      headers:{'Content-Type':'application/json', 'X-Dashboard-Request':'feishu'}, body:JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '本机连接器无法处理请求。');
    return result;
  }

  async function signature(row) {
    const bytes = new TextEncoder().encode(JSON.stringify(row.fields));
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2,'0')).join('');
  }

  async function loadConnection() {
    if (connection || !native()) return connection;
    if (!statusRequest) statusRequest = api('status').then(result => {
      connection = result; lastError = ''; return result;
    }).catch(error => { lastError = error.message; return null; }).finally(() => { statusRequest = null; });
    return statusRequest;
  }

  async function sync(row, fingerprint, conn) {
    working.add(row.key);
    attempted.set(row.key, fingerprint);
    redrawSoon();
    try {
      conn.records[row.key] = await api('sync', {destination:conn.config.appToken + '/' + conn.config.tableId, fields:row.fields});
    } catch (error) {
      conn.records[row.key] = {...conn.records[row.key], error:error.message || '本地服务无法连接。'};
    } finally {
      working.delete(row.key);
      redrawSoon();
    }
  }

  // Process the newest state again if another local commit arrived during an upload.
  function flush(ctx, retry = false) {
    if (!ctx || !native()) return Promise.resolve();
    if (retry) attempted.clear();
    pending = ctx;
    if (!processing) processing = (async () => {
      const conn = await loadConnection();
      if (!conn?.configured) {pending = null; return;}
      while (pending && connection === conn) {
        const current = pending;
        pending = null;
        for (const row of rowsFor(current.data).filter(item => item.eligible)) {
          if (pending || connection !== conn) break;
          const hash = await signature(row);
          if (conn.records[row.key]?.fingerprint !== hash && attempted.get(row.key) !== hash) await sync(row, hash, conn);
        }
      }
    })().catch(error => { lastError = error.message; }).finally(() => {
      processing = null; redrawSoon();
    });
    return processing;
  }
  window.addEventListener('online', () => attempted.clear());

  function redrawSoon() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = 0;
      if (active && active.panel.isConnected && !active.panel.closest('[hidden]')) drawRows(active);
    }, 60);
  }

  function syncState(row, hash) {
    if (!row.eligible) return '仅本机';
    if (working.has(row.key)) return '同步中';
    const stamp = connection?.records?.[row.key];
    if (stamp?.error) return '失败';
    return stamp?.syncedAt && stamp.fingerprint === hash ? '已同步' : '待同步';
  }

  function stampText(value) {
    if (!value) return '';
    const moment = new Date(value);
    return Number.isFinite(+moment) ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(moment) : '';
  }

  async function drawRows(view) {
    const draw = ++view.generation;
    const {panel,ctx} = view;
    const rows = rowsFor(ctx.data);
    const hashes = connection?.configured ? await Promise.all(rows.map(signature)) : [];
    if (view !== active || draw !== view.generation) return;
    const visible = rows.map((row, i) => ({row, state:syncState(row, hashes[i])})).filter(({row, state}) =>
      (!filters.project || row.projectIds.includes(filters.project)) && (!filters.product || row.productIds.includes(filters.product))
      && (!filters.person || row.personId === filters.person) && (!filters.date || [row.fields['行动日'],row.fields['截止日']].includes(filters.date))
      && (!filters.state || row.fields['状态'] === filters.state) && (!filters.sync || state === filters.sync));
    view.rows = new Map(rows.map(row => [row.key,row]));
    panel.querySelector('[data-feishu-summary]').textContent = connection?.configured ? '已连接多维表格' : (lastError || (native() ? '尚未连接飞书' : '当前在本机查看，请在 Mac App 配置飞书连接'));
    const target = panel.querySelector('[data-feishu-body]');
    target.innerHTML = visible.map(({row, state}) => {
      const f = row.fields;
      const stored = connection?.records?.[row.key] || {};
      const config = connection?.config;
      const link = stored.remoteId && config ? 'https://www.feishu.cn/base/' + encodeURIComponent(config.appToken) + '?table=' + encodeURIComponent(config.tableId) + '&record=' + encodeURIComponent(stored.remoteId) : '';
      const tags = [f['类型'], f['板块'], f['重点'] === '是' ? '重点' : ''].filter(Boolean);
      const sources = row.task ? row.reports.map(report =>
        `<button type="button" data-feishu-report="${escape(report.id)}">${escape(report.date)} 日报</button>`
      ).join('') : '';
      const retry = connection?.configured && ['待同步','失败'].includes(state);
      return `<tr data-feishu-id="${escape(row.key)}">
        <td><button type="button" data-feishu-open>${escape(f['事项'])}</button>
          <small>${escape(tags.join(' · '))}</small>
          ${f['重点原因'] ? '<small>' + escape(f['重点原因']) + '</small>' : ''}
        </td>
        <td>${escape(f['项目'] || '—')}<small>${escape(f['产品'])}</small></td>
        <td>${escape(f['负责人'] || '未分配')}</td>
        <td>${escape(f['行动日'] || '—')}<small>${f['截止日'] ? '截止 ' + escape(f['截止日']) : ''}</small></td>
        <td>${escape(f['状态'])}</td>
        <td data-feishu-status>${state}<small>${escape(stampText(stored.syncedAt))}</small>
          ${stored.error ? '<small>' + escape(stored.error) + '</small>' : ''}
        </td>
        <td>${sources}
          ${link ? '<a href="' + escape(link) + '" target="_blank" rel="noopener noreferrer">飞书原记录</a>' : ''}
          ${retry ? '<button type="button" data-feishu-retry>同步此项</button>' : ''}
        </td>
      </tr>`;
    }).join('');
    panel.querySelector('[data-feishu-empty]').hidden = visible.length > 0;
    panel.querySelector('[data-feishu-count]').textContent = visible.length + ' 条';
    panel.querySelector('[data-feishu-flush]').disabled = !connection?.configured;
  }

  function render(panel,ctx) {
    const data=ctx.data;
    const view = {panel,ctx,generation:0,rows:new Map()};
    active = view;
    const select = (key, label, choices) => '<label>' + label + '<select data-feishu-filter="' + key + '"><option value="">全部</option>' +
      choices.map(([id,name]) => '<option value="' + escape(id) + '"' + (filters[key] === id ? ' selected' : '') + '>' + escape(name) + '</option>').join('') + '</select></label>';
    const pairs = list => list.map(item => [item.id,item.name]);
    // Preserve an open connection editor on unrelated screen refreshes.
    const settings = panel.querySelector('#mm-feishu-config');
    const retain = settings?.open ? settings : null;
    panel.innerHTML = '<div class="fs-top"><span role="status" data-feishu-summary></span><button type="button" data-feishu-flush disabled>同步待处理项</button></div>' +
      '<details id="mm-feishu-config"><summary>连接设置与字段映射</summary><div data-feishu-settings></div></details>' +
      '<div class="fs-filters">' + select('project','项目',pairs(data.projects)) + select('product','产品',pairs(data.products)) + select('person','人员',pairs(data.people))
      + '<label>日期<input type="date" data-feishu-filter="date" value="' + escape(filters.date) + '"></label>' +
      select('state','工作状态',['待开始','进行中','待验收','已完成','受阻','已提交'].map(s=>[s,s])) + select('sync','同步状态',['仅本机','待同步','同步中','已同步','失败'].map(s=>[s,s])) +
      '<button type="button" data-feishu-clear>清除筛选</button></div>' +
      '<div class="fs-scroll"><table data-feishu-table><thead><tr><th>事项</th><th>项目／产品</th><th>负责人</th><th>行动日／截止日</th><th>状态</th><th>同步结果</th><th>关联记录</th></tr></thead><tbody data-feishu-body></tbody></table></div>' +
      '<p data-feishu-empty>暂无符合条件的事项。</p><small data-feishu-count></small>';
    const details=panel.querySelector('#mm-feishu-config');
    if (retain) details.replaceWith(retain);
    else details.addEventListener('toggle',()=>{ if(details.open && !details.querySelector('form')) showSettings(details,ctx); });
    panel.onchange=event=>{const key=event.target.dataset.feishuFilter;if(key){filters[key]=event.target.value;drawRows(view);}};
    panel.onclick=async event=>{
      const control=event.target.closest('button');
      if (!control) return;
      if (control.hasAttribute('data-feishu-clear')) {
        for (const input of panel.querySelectorAll('[data-feishu-filter]')) { filters[input.dataset.feishuFilter]='';input.value=''; }
        drawRows(view);return;
      }
      if (control.hasAttribute('data-feishu-flush')) { await flush(ctx,true);return;}
      const row=view.rows.get(control.closest('[data-feishu-id]')?.dataset.feishuId);
      if (!row) return;
      if (control.hasAttribute('data-feishu-retry')) {
        if (working.has(row.key)) return;
        const hash=await signature(row);
        if (!working.has(row.key) && connection?.configured) await sync(row,hash,connection);
      }
      if (control.hasAttribute('data-feishu-open') && row.task) ctx.openTask(row.task.id);
      else if (control.hasAttribute('data-feishu-open') || control.hasAttribute('data-feishu-report')) {
        const report=row.reports.find(r=>r.id===control.dataset.feishuReport) || row.reports[0];
        if (report) ctx.openReport(report.date,report.personId);
      }
    };
    drawRows(view);
    loadConnection().then(()=>{if(active===view) drawRows(view);});
  }

  async function showSettings(details,ctx) {
    await loadConnection();
    const formHost=details.querySelector('[data-feishu-settings]');
    const config=connection?.config || {};
    formHost.innerHTML='<p>提交的日报和已确认关联的任务，将按本地 ID 单向更新到同一张飞书多维表。其他任务仅在本机展示。</p>' +
      '<p>目标表需要以下同名文本列，应用需获得表格读写授权。</p><p class="fs-mapping">' + fieldNames.join('、') + '</p>' +
      (native() ? '<form><div class="fs-filters">' + [['appId','App ID'],['appSecret','App Secret'],['appToken','Base Token'],['tableId','Table ID']].map(([name, label])=>
        '<label>' + label + '<input name="' + name + '" type="' + (name==='appSecret'?'password':'text') + '" autocomplete="off" maxlength="512" value="' + escape(config[name] || '') + '" ' + (name==='appSecret' && connection?.configured ? 'placeholder="留空沿用已保存的密钥"' : 'required') + '></label>').join('') +
        '</div><p>验证成功后保存连接并开始同步已提交的内容。</p><button type="submit">验证连接并开始同步</button><span role="status"></span></form>' : '<p>请在独立 Mac App 内设置连接。</p>');
    const form=formHost.querySelector('form');
    if (!form) return;
    form.onsubmit=async event=>{
      event.preventDefault();const label=form.querySelector('[role=status]'),button=form.querySelector('button');button.disabled=true;label.textContent='正在验证连接…';
      try {
        if (processing) await processing;
        connection=await api('config',Object.fromEntries(new FormData(form)));
        form.elements.appSecret.value=''; form.elements.appSecret.required=false;
        lastError=''; attempted.clear(); label.textContent='已保存连接。'; redrawSoon();flush(ctx);
      } catch(error){label.textContent=error.message;}
      finally{button.disabled=false;}
    };
  }
  window.dashboardFeishu = Object.freeze({render,flush});
})();
