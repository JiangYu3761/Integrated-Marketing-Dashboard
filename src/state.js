/* The complete workspace is committed with one localStorage write. */
(() => {
  'use strict';
  const key = 'codex.cross-border-product-map';
  const unsaved = new Set();
  let lastRead;
  let unreadable = false;

  function setDirty(source, dirty) {
    if (dirty) unsaved.add(source);
    else unsaved.delete(source);
  }

  function inspectBackup(snapshot) {
    const data = snapshot?.privateContent?.data;
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const objects = list => Array.isArray(list) && list.every(record);
    const strings = list => Array.isArray(list) && list.every(value => typeof value === 'string');
    const identified = list => objects(list) && list.every(item => typeof item.id === 'string' && item.id) &&
      new Set(list.map(item => item.id)).size === list.length;
    if (!record(data) || ![1, 2, 3, 4, 5].includes(data.version) ||
        !identified(data.products) || !data.products.length || !identified(data.tasks) ||
        !identified(data.lanes) || !data.lanes.length || !strings(data.phases) || !data.phases.length ||
        !strings(data.roles)) {
      throw new Error('文件缺少有效的项目、产品、岗位、阶段或任务数据。');
    }
    for (const key of ['people', 'projects', 'modules']) {
      if (data[key] !== undefined && !identified(data[key])) throw new Error('备份中的人员、项目或板块记录无效。');
    }
    for (const key of ['reports', 'reportDrafts', 'taskDrafts']) {
      if (data[key] !== undefined && !objects(data[key])) throw new Error('备份中的日报或草稿格式无效。');
    }
    const invalidProduct = data.products.some(product => typeof product.name !== 'string' ||
      (product.phasePlans != null && !objects(product.phasePlans)));
    const invalidTask = data.tasks.some(task => typeof task.title !== 'string' ||
      (task.dailyWork != null && !identified(task.dailyWork)) ||
      (task.sourceReportIds != null && !strings(task.sourceReportIds)));
    if (invalidProduct || invalidTask) throw new Error('备份中的产品、任务或排期格式无效。');
    for (const report of [...(data.reports || []), ...(data.reportDrafts || [])]) {
      if (typeof report.id !== 'string' || typeof report.text !== 'string' || !objects(report.items) ||
          !report.items.every(item => typeof item.source === 'string' && typeof item.title === 'string') ||
          (report.completedSnapshot != null && !objects(report.completedSnapshot))) {
        throw new Error('日报的正文、工作事项或完成快照无效。');
      }
    }
    if (data.taskDrafts?.some(d => typeof d.key !== 'string' || !['quick', 'task'].includes(d.kind) ||
        (d.kind === 'task' && (!record(d.fields) || !identified(d.children))) ||
        (d.kind === 'quick' && (!record(d.q) || !record(d.q.draft))))) {
      throw new Error('任务草稿不完整。');
    }
    return data;
  }

  window.projectState = Object.freeze({
    read() {
      try {
        lastRead = window.localStorage.getItem(key);
        const state = lastRead === null ? null : JSON.parse(lastRead);
        unreadable = false;
        return state;
      } catch (error) {
        unreadable = true;
        console.warn('无法读取本地保存的数据。', error);
        return null;
      }
    },
    write(state, { restore = false } = {}) {
      if (unreadable && !restore) throw new Error('本机原有数据无法读取，请从备份恢复。');
      if (lastRead !== undefined && window.localStorage.getItem(key) !== lastRead) {
        throw new Error('另一窗口已更改数据，请先导出本窗口的备份，再重新打开。');
      }
      const value = JSON.stringify(state);
      window.localStorage.setItem(key, value);
      lastRead = value;
      unreadable = false;
    },
    protectOriginal() { unreadable = true; },
    setDirty,
    hasDirty: () => unsaved.size > 0,
    inspectBackup,
  });
})();
