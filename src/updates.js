(() => {
  'use strict';
  const panel = document.getElementById('mm-updates');
  const automatic = document.getElementById('mm-update-auto');
  const check = document.getElementById('mm-update-check');
  const status = document.getElementById('mm-update-status');
  const bridge = window.webkit?.messageHandlers?.desktopUpdates;
  if (!panel || !bridge) return;

  const send = message => {
    try { bridge.postMessage(message); }
    catch { status.textContent = '暂时无法连接应用更新服务，请稍后重试。'; }
  };
  window.addEventListener('desktop-update-status', event => {
    const value = event.detail;
    if (!value || typeof value.version !== 'string') return;
    document.getElementById('mm-update-version').textContent = '当前版本 ' + value.version + (value.latestVersion ? ' · 新版 ' + value.latestVersion : '');
    status.textContent = value.message || '尚未检查更新。';
    panel.dataset.phase = value.phase || 'idle';
    automatic.checked = value.automatic === true;
    automatic.disabled = value.phase === 'installing';
    check.disabled = value.busy === true || value.phase === 'installing';
    check.textContent = value.busy ? '正在检查与下载…' : '检查更新';
    const stamp = value.checkedAt ? new Date(value.checkedAt) : null;
    document.getElementById('mm-update-time').textContent = stamp && Number.isFinite(stamp.getTime())
      ? '上次检查：' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(stamp)
      : '';
  });
  automatic.addEventListener('change', () => send({ action: 'automatic', enabled: automatic.checked }));
  check.addEventListener('click', () => send({ action: 'check' }));
  // The native updater waits until task/settings editors have saved or closed.
  window.dashboardCanInstallUpdate = () => !document.querySelector('dialog[open], #mm-config:not([hidden]), [popover]:popover-open');
  window.dashboardSetUpdateLock = locked => { document.getElementById('market-map-template').inert = locked === true; };
  send({ action: 'status' });
})();
