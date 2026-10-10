const state = {
  token: localStorage.getItem('mock_console_user') || 'sim-user-a-token',
  devices: [], accounts: [], materials: [], tasks: [], videos: []
};
const $ = id => document.getElementById(id);
function log(message, data) {
  const text = data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  $('log').textContent = `[${new Date().toLocaleTimeString()}] ${text}\n` + $('log').textContent;
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), authorization: `Bearer ${state.token}` };
  if (options.json !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(options.json); delete options.json; }
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) { log(`请求失败 ${response.status}`, data); throw new Error(data?.error?.message || response.statusText); }
  return data;
}
function renderList(id, items, render) { $(id).innerHTML = items.length ? items.map(render).join('') : '<li>暂无</li>'; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function refreshAll() {
  const [devices, accounts, materials, tasks, videos] = await Promise.all([
    api('/api/v1/devices'), api('/api/v1/accounts'), api('/api/v1/materials'), api('/api/v1/tasks'), api('/api/v1/videos')
  ]);
  state.devices = devices.devices.filter(x => x.status === 'active');
  state.accounts = accounts.accounts;
  state.materials = materials.materials;
  state.tasks = tasks.tasks;
  state.videos = videos.videos;
  renderDevices(); renderAccounts(); renderMaterials(); renderTasks(); renderSelectors(); renderVideos();
}
function renderDevices() {
  renderList('devices', state.devices, d => `<li><b>${escapeHtml(d.name)}</b><br><code>${escapeHtml(d.id)}</code><br>最后心跳：${escapeHtml(d.last_seen_at || '未上报')}</li>`);
}
function renderAccounts() {
  renderList('accounts', state.accounts, a => `<li>${escapeHtml(a.platform)} / ${escapeHtml(a.nickname)}<br><code>${escapeHtml(a.id)}</code><br>设备：<code>${escapeHtml(a.device_id)}</code> 状态：${escapeHtml(a.status)}<br><button data-cmd-login="${escapeHtml(a.account_key)}" data-device="${escapeHtml(a.device_id)}">打开本机登录</button> <button class="secondary" data-cmd-recheck="${escapeHtml(a.account_key)}" data-device="${escapeHtml(a.device_id)}">重新检查登录</button></li>`);
}
function renderMaterials() {
  renderList('materials', state.materials, m => `<li>${escapeHtml(m.filename)} (${m.bytes} bytes)<br><code>${escapeHtml(m.id)}</code></li>`);
}
function option(value, label) { return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`; }
function renderSelectors() {
  $('deviceSelect').innerHTML = state.devices.map(d => option(d.id, d.name)).join('');
  const platform = $('platform').value;
  const deviceId = $('deviceSelect').value;
  $('accountSelect').innerHTML = state.accounts.filter(a => a.platform === platform && (!deviceId || a.device_id === deviceId)).map(a => option(a.id, a.nickname)).join('');
  $('materialSelect').innerHTML = state.materials.map(m => option(m.id, m.filename)).join('');
  $('pubDeviceSelect').innerHTML = state.devices.map(d => option(d.id, d.name)).join('');
  const pubPlatform = $('pubPlatform').value;
  const pubDeviceId = $('pubDeviceSelect').value;
  $('pubAccountSelect').innerHTML = state.accounts.filter(a => a.platform === pubPlatform && (!pubDeviceId || a.device_id === pubDeviceId)).map(a => option(a.id, a.nickname)).join('');
}
function renderVideos() {
  $('videoSelect').innerHTML = state.videos.map(v => option(v.id, `${v.name}（${v.version} / ${v.status}）`)).join('');
  renderVideoDetail();
}
async function renderVideoDetail() {
  const id = $('videoSelect').value;
  if (!id) { $('videoDetail').textContent = '暂无视频'; return; }
  try {
    const { video } = await api(`/api/v1/videos/${encodeURIComponent(id)}`);
    $('videoDetail').innerHTML = `<p>视频详情：ID <code>${escapeHtml(video.id)}</code>；名称 ${escapeHtml(video.name)}；版本 <code>${escapeHtml(video.version)}</code>；状态 ${escapeHtml(video.status)}${video.status !== 'ready' ? '（未准备好，不能发布）' : ''}</p>`;
  } catch (e) { $('videoDetail').textContent = `视频详情加载失败：${e.message}`; }
}
function statusName(s) { return ({queued:'排队',claimed:'已领取',downloading:'下载素材',uploading:'上传填写',ready_to_submit:'待最终提交',submitting:'提交中',submitted:'平台已接收',needs_user_action:'需要人工处理',outcome_unknown:'结果待核实',failed:'失败',cancelled:'已取消'})[s] || s; }
function renderTasks() {
  $('tasks').innerHTML = state.tasks.map(t => `<div class="task">
    <b>${escapeHtml(t.title)}</b> <span class="status">${statusName(t.status)}</span> 进度 ${t.progress}%<br>
    平台：${escapeHtml(t.platform)}；任务：<code>${escapeHtml(t.id)}</code><br>
    账号：<code>${escapeHtml(t.account_id)}</code>；设备：<code>${escapeHtml(t.device_id)}</code><br>
    ${t.error ? `错误：<code>${escapeHtml(JSON.stringify(t.error))}</code><br>` : ''}
    ${t.result ? `结果：<code>${escapeHtml(JSON.stringify(t.result))}</code><br>` : ''}
    <button data-cancel="${escapeHtml(t.id)}">取消未提交任务</button>
    <button data-events="${escapeHtml(t.id)}" class="secondary">查看事件</button>
    ${t.status === 'outcome_unknown' ? `<button data-review-ok="${escapeHtml(t.id)}">人工确认平台已接收</button><button data-review-fail="${escapeHtml(t.id)}" class="secondary">确认未成功</button>` : ''}
  </div>`).join('') || '暂无任务';
}
$('userSelect').value = state.token;
$('userSelect').onchange = () => { state.token = $('userSelect').value; localStorage.setItem('mock_console_user', state.token); refreshAll().catch(() => {}); };
$('platform').onchange = renderSelectors; $('deviceSelect').onchange = renderSelectors;
$('pubPlatform').onchange = renderSelectors; $('pubDeviceSelect').onchange = renderSelectors;
$('videoSelect').onchange = renderVideoDetail;
$('publishVideo').onclick = async () => {
  const video = state.videos.find(v => v.id === $('videoSelect').value);
  if (!video) return alert('请选择视频');
  const topics = $('pubTopics').value.split(/[，,]/).map(x => x.trim()).filter(Boolean);
  const result = await api('/api/v1/publish-tasks', { method: 'POST', json: {
    video_id: video.id,
    video_version: video.version,
    platform: $('pubPlatform').value,
    account_id: $('pubAccountSelect').value,
    device_id: $('pubDeviceSelect').value,
    title: $('pubTitle').value,
    description: $('pubDescription').value,
    topics,
    execution_mode: 'desktop_assistant',
    idempotency_key: `publish-${video.id}-${Date.now()}`
  }});
  log('发布任务创建结果', result); await refreshAll();
};
$('accounts').onclick = async event => {
  const loginKey = event.target.dataset.cmdLogin;
  const recheckKey = event.target.dataset.cmdRecheck;
  const deviceId = event.target.dataset.device;
  if (!loginKey && !recheckKey) return;
  const result = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/commands`, { method: 'POST', json: {
    type: loginKey ? 'open_login' : 'recheck_account',
    payload: { account_key: loginKey || recheckKey }
  }});
  log('命令已下发（设备心跳时执行）', result);
};
$('refreshAll').onclick = () => refreshAll().then(() => log('已刷新')).catch(() => {});
$('refreshTasks').onclick = async () => { state.tasks = (await api('/api/v1/tasks')).tasks; renderTasks(); };
$('confirmBinding').onclick = async () => {
  const bindingId = $('bindingId').value.trim(); const code = $('bindingCode').value.trim();
  const result = await api(`/api/v1/bindings/${encodeURIComponent(bindingId)}/confirm`, { method: 'POST', json: { code } });
  log('绑定确认成功', result); await refreshAll();
};
$('uploadMaterial').onclick = async () => {
  const file = $('materialFile').files[0]; if (!file) return alert('请选择文件');
  const response = await fetch('/api/v1/materials', { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '上传失败');
  log('素材上传成功', data); await refreshAll();
};
$('useSample').onclick = async () => {
  const blob = new Blob(['QIANJIANG_WENTIAN_CONTROLLED_TEST_ASSET_NOT_A_REAL_VIDEO'], { type: 'application/octet-stream' });
  const response = await fetch('/api/v1/materials', { method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'controlled-test-asset.bin' }, body: blob });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '上传失败');
  log('受控测试素材上传成功', data); await refreshAll();
};
$('createTask').onclick = async () => {
  const topics = $('topics').value.split(/[，,]/).map(x => x.trim()).filter(Boolean);
  const result = await api('/api/v1/tasks', { method: 'POST', json: {
    device_id: $('deviceSelect').value,
    account_id: $('accountSelect').value,
    platform: $('platform').value,
    title: $('title').value,
    description: $('description').value,
    topics,
    material_id: $('materialSelect').value,
    idempotency_key: `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }});
  log('任务创建结果', result); await refreshAll();
};
$('tasks').onclick = async event => {
  const cancel = event.target.dataset.cancel;
  const events = event.target.dataset.events;
  const reviewOk = event.target.dataset.reviewOk;
  const reviewFail = event.target.dataset.reviewFail;
  if (cancel) { log('取消任务', await api(`/api/v1/tasks/${encodeURIComponent(cancel)}/cancel`, { method: 'POST', json: {} })); await refreshAll(); }
  if (events) { log('任务事件', await api(`/api/v1/tasks/${encodeURIComponent(events)}/events`)); }
  if (reviewOk || reviewFail) {
    const id = reviewOk || reviewFail;
    log('人工核实结果', await api(`/api/v1/tasks/${encodeURIComponent(id)}/review`, { method: 'POST', json: { outcome: reviewOk ? 'submitted' : 'failed', note: '模拟控制台人工核实' } }));
    await refreshAll();
  }
};
const params = new URLSearchParams(location.search);
if (params.get('binding_id')) $('bindingId').value = params.get('binding_id');
refreshAll().catch(error => log('初始化失败', { message: error.message }));