const state = {
  meta: null,
  series: [],
  activeSeriesId: null,
  activeSeries: null,
  search: '',
  category: '',
  categoryDrafts: [],
  categoryDirty: false,
  categoryDialog: {
    open: false,
    index: null,
    name: '',
    folder: '',
  },
  folderBrowser: {
    open: false,
    loading: false,
    error: '',
    currentPath: '',
    parentPath: null,
    directories: [],
  },
};

const elements = {
  settingsForm: document.querySelector('#settings-form'),
  libraryRoot: document.querySelector('#library-root'),
  scanInterval: document.querySelector('#scan-interval'),
  separator: document.querySelector('#separator'),
  titleSegmentIndex: document.querySelector('#title-segment-index'),
  categorySegmentIndex: document.querySelector('#category-segment-index'),
  stripTokens: document.querySelector('#strip-tokens'),
  chapterTemplate: document.querySelector('#chapter-template'),
  scanButton: document.querySelector('#scan-button'),
  scanStatusText: document.querySelector('#scan-status-text'),
  summaryText: document.querySelector('#summary-text'),
  summaryGrid: document.querySelector('#summary-grid'),
  searchInput: document.querySelector('#search-input'),
  categoryFilter: document.querySelector('#category-filter'),
  seriesGrid: document.querySelector('#series-grid'),
  detailView: document.querySelector('#detail-view'),
  detailCaption: document.querySelector('#detail-caption'),
  summaryCardTemplate: document.querySelector('#summary-card-template'),
  categoryList: document.querySelector('#category-list'),
  addCategoryButton: document.querySelector('#add-category-button'),
  saveCategoryButton: document.querySelector('#save-category-button'),
  categorySuggestions: document.querySelector('#category-suggestions'),
  categoryDialog: document.querySelector('#category-dialog'),
  categoryDialogTitle: document.querySelector('#category-dialog-title'),
  categoryDialogName: document.querySelector('#category-dialog-name'),
  categoryDialogFolder: document.querySelector('#category-dialog-folder'),
  categoryDialogBrowse: document.querySelector('#category-dialog-browse'),
  categoryDialogClose: document.querySelector('#category-dialog .dialog-close-button'),
  categoryDialogCancel: document.querySelector('#category-dialog .dialog-footer .action-button:not(.action-primary)'),
  categoryDialogConfirm: document.querySelector('#category-dialog .dialog-footer .action-primary'),
  categoryDialogBackdrop: document.querySelector('#category-dialog .dialog-backdrop'),
  folderBrowserDialog: document.querySelector('#folder-browser-dialog'),
  folderBrowserCurrentPath: document.querySelector('#folder-browser-current-path'),
  folderBrowserParentButton: document.querySelector('#folder-browser-parent-button'),
  folderBrowserList: document.querySelector('#folder-browser-list'),
  folderBrowserConfirmButton: document.querySelector('#folder-browser-confirm-button'),
  folderBrowserClose: document.querySelector('#folder-browser-dialog .dialog-close-button'),
  folderBrowserCancel: document.querySelector('#folder-browser-dialog .dialog-footer .action-button:not(.action-primary)'),
  folderBrowserBackdrop: document.querySelector('#folder-browser-dialog .dialog-backdrop'),
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || '请求失败');
  }

  return response.json();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateLabel(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '未执行';
}

function isAbsolutePath(value) {
  return String(value ?? '').startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(value ?? ''));
}

function normalizeSlash(value, separator) {
  return String(value ?? '').replace(/[\\/]+/g, separator);
}

function joinPath(basePath, childPath) {
  const base = String(basePath ?? '').trim();
  const child = String(childPath ?? '').trim();

  if (!base) {
    return child;
  }
  if (!child) {
    return base;
  }

  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const normalizedBase = base.replace(/[\\/]+$/, '');
  const normalizedChild = normalizeSlash(child.replace(/^[\\/]+/, ''), separator);
  return `${normalizedBase}${separator}${normalizedChild}`;
}

function resolveFolderForBrowse(folder) {
  const rawFolder = String(folder ?? '').trim();
  if (!rawFolder) {
    return '';
  }
  if (isAbsolutePath(rawFolder)) {
    return rawFolder;
  }

  const libraryRoot = state.meta?.settings?.libraryRoot ?? '';
  return libraryRoot ? joinPath(libraryRoot, rawFolder) : rawFolder;
}

function formatFolderDisplay(folder) {
  return resolveFolderForBrowse(folder) || '未选择目录';
}

function setDialogVisibility(dialog, visible) {
  if (!dialog) {
    return;
  }

  if (visible) {
    dialog.removeAttribute('hidden');
    dialog.setAttribute('aria-hidden', 'false');
  } else {
    dialog.setAttribute('hidden', '');
    dialog.setAttribute('aria-hidden', 'true');
  }

  document.body.style.overflow =
    state.categoryDialog.open || state.folderBrowser.open ? 'hidden' : '';
}

function setStatusMessage(message) {
  elements.detailView.className = 'detail-view empty-state';
  elements.detailView.textContent = message;
}

function showError(error) {
  window.alert(error?.message || '发生未知错误');
}

function renderSettings(meta) {
  const settings = meta.settings;
  elements.libraryRoot.value = settings.libraryRoot;
  elements.scanInterval.value = settings.scanIntervalMinutes;
  elements.separator.value = settings.folderPattern.separator;
  elements.titleSegmentIndex.value = settings.folderPattern.titleSegmentIndex;
  elements.categorySegmentIndex.value = settings.folderPattern.categorySegmentIndex;
  elements.stripTokens.value = settings.folderPattern.stripTokens.join(', ');
  elements.chapterTemplate.value = settings.naming.directImageChapterTemplate;
}

function syncCategoryDraftsFromMeta(force = false) {
  if (!state.meta) {
    return;
  }

  if (!force && state.categoryDirty) {
    return;
  }

  state.categoryDrafts = (state.meta.settings.categoryFolders ?? []).map((item) => ({
    name: item.name,
    folder: item.folder ?? '',
  }));
  state.categoryDirty = false;
}

function renderCategorySuggestions(categories) {
  elements.categorySuggestions.innerHTML = '';
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = category;
    elements.categorySuggestions.appendChild(option);
  }
}

function renderCategoryManager() {
  elements.categoryList.innerHTML = '';

  if (state.categoryDrafts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty';
    empty.textContent = '还没有配置分类。点击“添加分类”开始。';
    elements.categoryList.appendChild(empty);
  } else {
    for (const [index, item] of state.categoryDrafts.entries()) {
      const row = document.createElement('article');
      row.className = 'category-row';
      row.innerHTML = `
        <label>
          <span>分类名称</span>
          <input type="text" value="${escapeHtml(item.name)}" readonly />
        </label>
        <label>
          <span>目录路径</span>
          <input type="text" value="${escapeHtml(formatFolderDisplay(item.folder))}" readonly />
        </label>
        <div class="toolbar-actions">
          <button data-role="edit" data-index="${index}" class="action-button" type="button">编辑</button>
          <button data-role="remove" data-index="${index}" class="action-button action-danger" type="button">删除</button>
        </div>
      `;
      elements.categoryList.appendChild(row);
    }
  }

  elements.saveCategoryButton.disabled = !state.categoryDirty;
  elements.saveCategoryButton.textContent = state.categoryDirty ? '应用变更' : '已同步';
}

function renderMeta(meta, forceCategoryReset = false) {
  state.meta = meta;
  renderSettings(meta);
  syncCategoryDraftsFromMeta(forceCategoryReset);
  renderCategoryManager();

  const status = meta.scanStatus;
  const statusParts = [
    `最后扫描: ${meta.lastScanLabel}`,
    status.running ? '当前状态: 扫描中' : '当前状态: 空闲',
  ];

  if (status.finishedAt) {
    statusParts.push(`结束时间: ${formatDateLabel(status.finishedAt)}`);
  }
  if (status.error) {
    statusParts.push(`错误: ${status.error}`);
  }

  elements.scanStatusText.textContent = statusParts.join(' | ');
  elements.summaryText.textContent = `扫描目录: ${meta.settings.libraryRoot}`;

  const metrics = [
    ['漫画数', meta.summary.seriesCount],
    ['卷数', meta.summary.volumeCount],
    ['章节数', meta.summary.chapterCount],
    ['图片数', meta.summary.pageCount],
  ];

  elements.summaryGrid.innerHTML = '';
  for (const [label, value] of metrics) {
    const node = elements.summaryCardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.summary-label').textContent = label;
    node.querySelector('.summary-value').textContent = value;
    elements.summaryGrid.appendChild(node);
  }

  const availableCategories = meta.knownCategories;
  const currentValue = availableCategories.includes(state.category) ? state.category : '';
  state.category = currentValue;
  elements.categoryFilter.innerHTML = '<option value="">全部</option>';
  for (const category of availableCategories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    if (currentValue === category) {
      option.selected = true;
    }
    elements.categoryFilter.appendChild(option);
  }

  renderCategorySuggestions(availableCategories);
}

function renderSeriesList() {
  elements.seriesGrid.innerHTML = '';

  if (state.series.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前筛选条件下没有结果。';
    elements.seriesGrid.appendChild(empty);
    return;
  }

  for (const item of state.series) {
    const article = document.createElement('article');
    article.className = `series-card${item.id === state.activeSeriesId ? ' active' : ''}`;
    article.innerHTML = `
      <button class="series-card-button" type="button">
        <div class="series-cover-shell">
          ${
            item.coverUrl
              ? `<img class="series-cover" src="${item.coverUrl}" alt="${escapeHtml(item.title)}" loading="lazy" />`
              : '<div class="series-cover placeholder">无封面</div>'
          }
        </div>
        <div class="series-card-body">
          <p class="series-title">${escapeHtml(item.title)}</p>
          <p class="series-source">${escapeHtml(item.sourceKey)}</p>
          <p class="series-meta">${item.counts.volumes} 卷 / ${item.counts.chapters} 章 / ${item.counts.pages} 页</p>
          <div class="tag-row">
            ${item.categories.folder.map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join('')}
          </div>
        </div>
      </button>
    `;

    article.querySelector('button').addEventListener('click', async () => {
      state.activeSeriesId = item.id;
      try {
        await loadSeriesDetail(item.id);
        renderSeriesList();
      } catch (error) {
        showError(error);
      }
    });

    elements.seriesGrid.appendChild(article);
  }
}

function renderDetail() {
  if (!state.activeSeries) {
    elements.detailView.className = 'detail-view empty-state';
    elements.detailView.textContent = '还没有选中漫画。';
    return;
  }

  const detail = state.activeSeries;
  elements.detailCaption.textContent = detail.sourcePath;
  elements.detailView.className = 'detail-view';
  elements.detailView.innerHTML = `
    <section class="detail-header">
      <div class="detail-cover-block">
        ${
          detail.coverUrl
            ? `<img class="detail-cover" src="${detail.coverUrl}" alt="${escapeHtml(detail.title)}" />`
            : '<div class="detail-cover placeholder">无封面</div>'
        }
      </div>
      <div class="detail-copy">
        <p class="detail-title">${escapeHtml(detail.title)}</p>
        <p class="detail-meta">${detail.counts.volumes} 卷 / ${detail.counts.chapters} 章 / ${detail.counts.pages} 页</p>
        <p class="muted">分类：${detail.categories.folder.join('，') || '无'}</p>
        <label class="detail-category-editor">
          <span>手动分类</span>
          <input
            id="manual-categories-input"
            list="category-suggestions"
            type="text"
            value="${escapeHtml(detail.categories.manual.join(', '))}"
            placeholder="多个分类用逗号分隔"
          />
        </label>
        <div class="tag-row">
          ${detail.categories.folder.map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join('')}
        </div>
        <button id="save-categories-button" class="action-button action-primary" type="button">保存分类</button>
      </div>
    </section>
    <section class="volume-stack">
      ${detail.volumes
        .map((volume) => {
          return `
            <article class="volume-card">
              <div class="volume-header">
                <div>
                  <p class="volume-title">${escapeHtml(volume.title)}</p>
                  <p class="muted">${volume.synthetic ? '自动合成卷' : escapeHtml(volume.sourcePath)}</p>
                </div>
              </div>
              <div class="chapter-list">
                ${volume.chapters
                  .map((chapter) => {
                    return `
                      <div class="chapter-row">
                        <div>
                          <p class="chapter-title">${escapeHtml(chapter.title)}</p>
                          <p class="muted">${chapter.pageCount} 页</p>
                        </div>
                        ${
                          chapter.firstPageUrl
                            ? `<a class="inline-link" href="${chapter.firstPageUrl}" target="_blank" rel="noreferrer">查看首页</a>`
                            : ''
                        }
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            </article>
          `;
        })
        .join('')}
    </section>
  `;

  document.querySelector('#save-categories-button')?.addEventListener('click', async () => {
    const rawValue = document.querySelector('#manual-categories-input')?.value ?? '';
    const categories = rawValue
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      await api(`/api/series/${detail.id}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ categories }),
      });
      await refreshAll(true);
      await loadSeriesDetail(detail.id);
    } catch (error) {
      showError(error);
    }
  });
}

function updateCategoryDialogState() {
  const isEditing = Number.isInteger(state.categoryDialog.index);
  elements.categoryDialogTitle.textContent = isEditing ? '编辑分类' : '添加分类';
  elements.categoryDialogName.value = state.categoryDialog.name;
  elements.categoryDialogFolder.value = state.categoryDialog.folder;
  elements.categoryDialogConfirm.textContent = isEditing ? '更新分类' : '保存分类';
  elements.categoryDialogConfirm.disabled =
    !state.categoryDialog.name.trim() || !state.categoryDialog.folder.trim();
  setDialogVisibility(elements.categoryDialog, state.categoryDialog.open);
}

function renderFolderBrowser() {
  setDialogVisibility(elements.folderBrowserDialog, state.folderBrowser.open);
  elements.folderBrowserCurrentPath.textContent = state.folderBrowser.currentPath || '请选择挂载点';
  elements.folderBrowserParentButton.disabled =
    state.folderBrowser.loading || state.folderBrowser.parentPath === null;
  elements.folderBrowserConfirmButton.disabled =
    state.folderBrowser.loading || !state.folderBrowser.currentPath;

  elements.folderBrowserList.innerHTML = '';

  if (state.folderBrowser.loading) {
    const loading = document.createElement('div');
    loading.className = 'empty-state compact-empty';
    loading.textContent = '正在读取目录...';
    elements.folderBrowserList.appendChild(loading);
    return;
  }

  if (state.folderBrowser.error) {
    const error = document.createElement('div');
    error.className = 'empty-state compact-empty';
    error.textContent = state.folderBrowser.error;
    elements.folderBrowserList.appendChild(error);
    return;
  }

  if (state.folderBrowser.directories.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty';
    empty.textContent = '当前目录下没有子目录。';
    elements.folderBrowserList.appendChild(empty);
    return;
  }

  for (const item of state.folderBrowser.directories) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-item';
    button.dataset.role = 'open-folder';
    button.dataset.path = item.path;
    button.title = item.path;
    button.textContent = item.name;
    elements.folderBrowserList.appendChild(button);
  }
}

function openCategoryDialog(index = null) {
  const current = Number.isInteger(index) ? state.categoryDrafts[index] : null;
  state.categoryDialog.open = true;
  state.categoryDialog.index = Number.isInteger(index) ? index : null;
  state.categoryDialog.name = current?.name ?? '';
  state.categoryDialog.folder = resolveFolderForBrowse(current?.folder ?? '');
  updateCategoryDialogState();
  window.setTimeout(() => {
    elements.categoryDialogName?.focus();
  }, 0);
}

function closeCategoryDialog() {
  state.categoryDialog.open = false;
  updateCategoryDialogState();
}

function saveCategoryDraftFromDialog() {
  const name = state.categoryDialog.name.trim();
  const folder = state.categoryDialog.folder.trim();

  if (!name || !folder) {
    window.alert('请先填写分类名称并选择目录。');
    return;
  }

  const nextItem = { name, folder };
  if (Number.isInteger(state.categoryDialog.index) && state.categoryDrafts[state.categoryDialog.index]) {
    state.categoryDrafts[state.categoryDialog.index] = nextItem;
  } else {
    state.categoryDrafts.push(nextItem);
  }

  state.categoryDirty = true;
  closeCategoryDialog();
  renderCategoryManager();
}

function removeCategoryDraft(index) {
  state.categoryDrafts.splice(index, 1);
  state.categoryDirty = true;
  renderCategoryManager();
}

async function requestFolderBrowse(pathname = '') {
  const params = new URLSearchParams();
  if (pathname) {
    params.set('path', pathname);
  }

  return api(params.size ? `/api/folders/browse?${params.toString()}` : '/api/folders/browse');
}

async function loadFolderBrowser(pathname = '') {
  state.folderBrowser.loading = true;
  state.folderBrowser.error = '';
  renderFolderBrowser();

  try {
    let payload;
    try {
      payload = await requestFolderBrowse(pathname);
    } catch (error) {
      if (!pathname) {
        throw error;
      }
      payload = await requestFolderBrowse('');
    }

    state.folderBrowser.currentPath = payload.currentPath ?? '';
    state.folderBrowser.parentPath = payload.parentPath ?? null;
    state.folderBrowser.directories = payload.directories ?? [];
  } catch (error) {
    state.folderBrowser.currentPath = '';
    state.folderBrowser.parentPath = null;
    state.folderBrowser.directories = [];
    state.folderBrowser.error = error.message;
  } finally {
    state.folderBrowser.loading = false;
    renderFolderBrowser();
  }
}

async function openFolderBrowser() {
  state.folderBrowser.open = true;
  renderFolderBrowser();
  await loadFolderBrowser(state.categoryDialog.folder);
}

function closeFolderBrowser() {
  state.folderBrowser.open = false;
  renderFolderBrowser();
}

function confirmFolderBrowserSelection() {
  if (!state.folderBrowser.currentPath) {
    return;
  }

  state.categoryDialog.folder = state.folderBrowser.currentPath;
  updateCategoryDialogState();
  closeFolderBrowser();
}

async function loadSeriesList() {
  const params = new URLSearchParams();
  if (state.search) {
    params.set('search', state.search);
  }
  if (state.category) {
    params.set('category', state.category);
  }

  const payload = await api(`/api/series?${params.toString()}`);
  state.series = payload.items;
  renderSeriesList();
}

async function loadSeriesDetail(seriesId) {
  state.activeSeries = await api(`/api/series/${seriesId}`);
  renderDetail();
}

async function restoreActiveSeriesDetail() {
  if (!state.activeSeriesId) {
    return;
  }

  try {
    await loadSeriesDetail(state.activeSeriesId);
  } catch {
    state.activeSeriesId = null;
    state.activeSeries = null;
    renderDetail();
  }
}

async function refreshAll(forceCategoryReset = false) {
  const meta = await api('/api/state');
  renderMeta(meta, forceCategoryReset);
  await loadSeriesList();
}

async function saveSettings(event) {
  event.preventDefault();

  const payload = {
    libraryRoot: elements.libraryRoot.value.trim(),
    scanIntervalMinutes: Number.parseInt(elements.scanInterval.value, 10) || 0,
    folderPattern: {
      enabled: true,
      separator: elements.separator.value.trim() || '-',
      titleSegmentIndex: Number.parseInt(elements.titleSegmentIndex.value, 10) || 0,
      categorySegmentIndex: Number.parseInt(elements.categorySegmentIndex.value, 10) || 1,
      stripTokens: elements.stripTokens.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    },
    naming: {
      defaultVolumeName: '默认卷',
      directImageChapterTemplate: elements.chapterTemplate.value.trim() || '{count}P',
    },
  };

  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    await api('/api/scan', { method: 'POST' });
    await refreshAll(true);
    await restoreActiveSeriesDetail();
  } catch (error) {
    showError(error);
  }
}

async function runScan() {
  elements.scanButton.disabled = true;
  try {
    await api('/api/scan', { method: 'POST' });
    await refreshAll(false);
    await restoreActiveSeriesDetail();
  } catch (error) {
    showError(error);
  } finally {
    elements.scanButton.disabled = false;
  }
}

async function saveCategoryFolders() {
  if (!state.categoryDirty) {
    return;
  }

  const items = state.categoryDrafts.map((item) => ({
    name: item.name.trim(),
    folder: item.folder.trim(),
  }));

  if (items.some((item) => (item.name && !item.folder) || (!item.name && item.folder))) {
    window.alert('存在未完成的分类，请确保每条分类都同时填写名称和目录。');
    return;
  }

  elements.saveCategoryButton.disabled = true;

  try {
    await api('/api/categories', {
      method: 'PUT',
      body: JSON.stringify({
        items: items.filter((item) => item.name && item.folder),
      }),
    });

    state.categoryDirty = false;
    await api('/api/scan', { method: 'POST' });
    await refreshAll(true);
    await restoreActiveSeriesDetail();
  } catch (error) {
    showError(error);
  } finally {
    renderCategoryManager();
  }
}

function bindEvents() {
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.scanButton.addEventListener('click', runScan);
  elements.addCategoryButton.addEventListener('click', () => openCategoryDialog());
  elements.saveCategoryButton.addEventListener('click', saveCategoryFolders);

  elements.searchInput.addEventListener('input', async (event) => {
    state.search = event.target.value.trim();
    try {
      await loadSeriesList();
    } catch (error) {
      showError(error);
    }
  });

  elements.categoryFilter.addEventListener('change', async (event) => {
    state.category = event.target.value;
    try {
      await loadSeriesList();
    } catch (error) {
      showError(error);
    }
  });

  elements.categoryList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-role]');
    if (!button) {
      return;
    }

    const role = button.dataset.role;
    const index = Number.parseInt(button.dataset.index, 10);
    if (!Number.isInteger(index) || !state.categoryDrafts[index]) {
      return;
    }

    if (role === 'edit') {
      openCategoryDialog(index);
      return;
    }

    if (role === 'remove') {
      removeCategoryDraft(index);
    }
  });

  elements.categoryDialogName.addEventListener('input', (event) => {
    state.categoryDialog.name = event.target.value;
    elements.categoryDialogConfirm.disabled =
      !state.categoryDialog.name.trim() || !state.categoryDialog.folder.trim();
  });

  elements.categoryDialogBrowse.addEventListener('click', async () => {
    try {
      await openFolderBrowser();
    } catch (error) {
      showError(error);
    }
  });

  elements.categoryDialogClose.addEventListener('click', closeCategoryDialog);
  elements.categoryDialogCancel.addEventListener('click', closeCategoryDialog);
  elements.categoryDialogConfirm.addEventListener('click', saveCategoryDraftFromDialog);
  elements.categoryDialogBackdrop.addEventListener('click', closeCategoryDialog);

  elements.folderBrowserClose.addEventListener('click', closeFolderBrowser);
  elements.folderBrowserCancel.addEventListener('click', closeFolderBrowser);
  elements.folderBrowserBackdrop.addEventListener('click', closeFolderBrowser);
  elements.folderBrowserConfirmButton.addEventListener('click', confirmFolderBrowserSelection);
  elements.folderBrowserParentButton.addEventListener('click', async () => {
    if (state.folderBrowser.parentPath === null || state.folderBrowser.loading) {
      return;
    }

    await loadFolderBrowser(state.folderBrowser.parentPath ?? '');
  });

  elements.folderBrowserList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-role="open-folder"]');
    if (!button || state.folderBrowser.loading) {
      return;
    }

    await loadFolderBrowser(button.dataset.path ?? '');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }

    if (state.folderBrowser.open) {
      closeFolderBrowser();
      return;
    }

    if (state.categoryDialog.open) {
      closeCategoryDialog();
    }
  });
}

async function bootstrap() {
  bindEvents();
  await refreshAll(true);
  renderDetail();
  updateCategoryDialogState();
  renderFolderBrowser();

  window.setInterval(() => {
    void refreshAll(false);
  }, 30000);
}

bootstrap().catch((error) => {
  setStatusMessage(error.message);
});
