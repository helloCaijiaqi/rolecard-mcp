// rolecard-mcp 管理页逻辑：fetch 本机回环端点（/admin/api/*），无构建步骤。
// 数据流：列表 → 选中 → 拉内容 → 编辑 → 保存（PUT）→ 刷新列表。

const $ = (sel) => document.querySelector(sel);
const listEl = $('#role-list');
const editorEl = $('#editor');
const emptyEl = $('#editor-empty');
const nameEl = $('#editor-name');
const contentEl = $('#editor-content');
const countEl = $('#char-count');
const saveBtn = $('#btn-save');
const currentNameEl = $('#current-name');
const currentBadgeEl = $('#current-badge');

let currentRole = ''; // 服务端当前应用的角色
let selectedRole = null; // 正在编辑的角色
let savedContent = ''; // 服务端已保存版本（脏检查用）

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-host').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

function renderList(roles) {
  listEl.innerHTML = '';
  if (!roles.length) {
    listEl.innerHTML = '<li class="text-slate-500 text-sm">roles 目录为空</li>';
    return;
  }
  for (const name of roles) {
    const li = document.createElement('li');
    li.className = 'role-item' + (name === currentRole ? ' active' : '') + (name === selectedRole ? ' selected' : '');
    const label = document.createElement('span');
    label.textContent = name;
    li.appendChild(label);
    if (name === currentRole) {
      const badge = document.createElement('span');
      badge.className = 'badge-current';
      badge.textContent = '当前';
      li.appendChild(badge);
    }
    li.addEventListener('click', () => selectRole(name));
    listEl.appendChild(li);
  }
}

function refreshCurrentBadge() {
  currentBadgeEl.hidden = !currentRole;
  currentNameEl.textContent = currentRole || '—';
}

function updateCharCount() {
  countEl.textContent = `${contentEl.value.length} 字符` + (contentEl.value !== savedContent ? '（未保存）' : '');
}

async function loadList() {
  try {
    const data = await api('/admin/api/roles');
    currentRole = typeof data.current === 'string' ? data.current : (data.current?.name ?? '');
    refreshCurrentBadge();
    renderList(data.roles ?? []);
  } catch (error) {
    listEl.innerHTML = `<li class="text-sm" style="color:var(--err)">加载失败：${error.message}</li>`;
  }
}

async function selectRole(name) {
  selectedRole = name;
  emptyEl.hidden = true;
  editorEl.hidden = false;
  nameEl.textContent = name;
  try {
    const data = await api(`/admin/api/roles/${encodeURIComponent(name)}`);
    savedContent = data.content ?? '';
    contentEl.value = savedContent;
    renderList(await api('/admin/api/roles').then((d) => d.roles ?? []));
  } catch (error) {
    toast(`读取失败：${error.message}`, 'err');
  }
  updateCharCount();
}

async function save() {
  const content = contentEl.value;
  if (!content.trim()) { toast('内容不能为空', 'err'); return; }
  saveBtn.disabled = true;
  try {
    await api(`/admin/api/roles/${encodeURIComponent(selectedRole)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    savedContent = content;
    toast(`已保存「${selectedRole}」（写盘即生效，下一回合注入）`);
    await loadList();
  } catch (error) {
    toast(`保存失败：${error.message}`, 'err');
  } finally {
    saveBtn.disabled = false;
    updateCharCount();
  }
}

contentEl.addEventListener('input', updateCharCount);
saveBtn.addEventListener('click', save);
loadList();
