const state = {
  meta: null,
  series: [],
  activeSeriesId: null,
  activeSeries: null,
  search: '',
  category: '',
  folderOptions: [],
  categoryDrafts: [],
  categoryDirty: false,
};

const elements = {
  settingsForm: document.querySelector('#settings-form'),
  libraryRoot: document.querySelector('#library-root'),
  scanInterval: document.querySelector('#scan-interval'),
  autoExport: document.querySelector('#auto-export'),
  separator: document.querySelector('#separator'),
  titleSegmentIndex: document.querySelector('#title-segment-index'),
  categorySegmentIndex: document.querySelector('#category-segment-index'),
  stripTokens: document.querySelector('#strip-tokens'),
  chapterTemplate: document.querySelector('#chapter-template'),
  scanButton: document.querySelector('#scan-button'),
  exportButton: document.querySelector('#export-button'),
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

function renderSettings(meta) {
  const settings = meta.settings;
  elements.libraryRoot.value = settings.libraryRoot;
  elements.scanInterval.value = settings.scanIntervalMinutes;
  elements.autoExport.checked = settings.autoExportToMihon;
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
    empty.textContent = '还没有配置分类目录。';
    elements.categoryList.appendChild(empty);
    return;
  }

  for (const [index, item] of state.categoryDrafts.entries()) {
    const row = document.createElement('div');
    row.className = 'category-row';

    const options = state.folderOptions
      .map((folder) => {
        const selected = folder.path === item.folder ? ' selected' : '';
        return `<option value="${escapeHtml(folder.path)}"${selected}>${escapeHtml(folder.label)}</option>`;
      })
      .join('');

    row.innerHTML = `
      <label>
        <span>分类名</span>
        <input data-role="name" data-index="${index}" type="text" value="${escapeHtml(item.name)}" placeholder="例如：清纯" />
      </label>
      <label>
        <span>对应文件夹</span>
        <select data-role="folder" data-index="${index}">
          ${options}
        </select>
      </label>
      <button data-role="remove" data-index="${index}" class="action-button action-danger" type="button">删除</button>
    `;

    elements.categoryList.appendChild(row);
  }
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
  elements.summaryText.textContent =
    `导出目录: ${meta.exportRoot} | Mihon 导出: ${
      meta.exportInfo?.generatedAt ? formatDateLabel(meta.exportInfo.generatedAt) : '未生成'
    }`;

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

  const currentValue = state.category;
  elements.categoryFilter.innerHTML = '<option value="">全部</option>';
  for (const category of meta.knownCategories) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    if (currentValue === category) {
      option.selected = true;
    }
    elements.categoryFilter.appendChild(option);
  }

  renderCategorySuggestions(meta.knownCategories);
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
          <p class="series-meta">${item.counts.volumes} 卷 / ${item.counts.chapters} 章 / ${item.counts.pages} 张</p>
          <div class="tag-row">
            ${item.categories.effective.map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join('')}
          </div>
        </div>
      </button>
    `;

    article.querySelector('button').addEventListener('click', async () => {
      state.activeSeriesId = item.id;
      await loadSeriesDetail(item.id);
      renderSeriesList();
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
        <p class="detail-meta">${detail.counts.volumes} 卷 / ${detail.counts.chapters} 章 / ${detail.counts.pages} 张</p>
        <p class="muted">目录分类：${detail.categories.folder.join('，') || '无'}</p>
        <p class="muted">目录名分类：${detail.categories.auto.join('，') || '无'}</p>
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
          ${detail.categories.effective.map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join('')}
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
                          <p class="muted">${chapter.pageCount} 张</p>
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

    await api(`/api/series/${detail.id}/categories`, {
      method: 'PUT',
      body: JSON.stringify({ categories }),
    });

    await refreshAll(true);
    await loadSeriesDetail(detail.id);
  });
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

async function refreshAll(forceCategoryReset = false) {
  const [meta, folders] = await Promise.all([api('/api/state'), api('/api/folders')]);
  state.folderOptions = folders.items;
  renderMeta(meta, forceCategoryReset);
  await loadSeriesList();
}

async function saveSettings(event) {
  event.preventDefault();

  const payload = {
    libraryRoot: elements.libraryRoot.value.trim(),
    scanIntervalMinutes: Number.parseInt(elements.scanInterval.value, 10) || 0,
    autoExportToMihon: elements.autoExport.checked,
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

  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  await api('/api/scan', { method: 'POST' });
  await refreshAll(true);
}

async function runScan() {
  elements.scanButton.disabled = true;
  try {
    await api('/api/scan', { method: 'POST' });
    await refreshAll(false);
    if (state.activeSeriesId) {
      await loadSeriesDetail(state.activeSeriesId);
    }
  } finally {
    elements.scanButton.disabled = false;
  }
}

async function runExport() {
  elements.exportButton.disabled = true;
  try {
    await api('/api/export', { method: 'POST' });
    await refreshAll(false);
  } finally {
    elements.exportButton.disabled = false;
  }
}

function addCategoryDraft() {
  state.categoryDrafts.push({ name: '', folder: '' });
  state.categoryDirty = true;
  renderCategoryManager();
}

async function saveCategoryFolders() {
  elements.saveCategoryButton.disabled = true;

  try {
    const items = state.categoryDrafts
      .map((item) => ({
        name: item.name.trim(),
        folder: item.folder,
      }))
      .filter((item) => item.name);

    await api('/api/categories', {
      method: 'PUT',
      body: JSON.stringify({ items }),
    });

    state.categoryDirty = false;
    await api('/api/scan', { method: 'POST' });
    await refreshAll(true);

    if (state.activeSeriesId) {
      await loadSeriesDetail(state.activeSeriesId);
    }
  } finally {
    elements.saveCategoryButton.disabled = false;
  }
}

function bindEvents() {
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.scanButton.addEventListener('click', runScan);
  elements.exportButton.addEventListener('click', runExport);
  elements.addCategoryButton.addEventListener('click', addCategoryDraft);
  elements.saveCategoryButton.addEventListener('click', saveCategoryFolders);

  elements.searchInput.addEventListener('input', async (event) => {
    state.search = event.target.value.trim();
    await loadSeriesList();
  });

  elements.categoryFilter.addEventListener('change', async (event) => {
    state.category = event.target.value;
    await loadSeriesList();
  });

  elements.categoryList.addEventListener('input', (event) => {
    const role = event.target.dataset.role;
    const index = Number.parseInt(event.target.dataset.index, 10);

    if (role === 'name' && Number.isInteger(index) && state.categoryDrafts[index]) {
      state.categoryDrafts[index].name = event.target.value;
      state.categoryDirty = true;
    }
  });

  elements.categoryList.addEventListener('change', (event) => {
    const role = event.target.dataset.role;
    const index = Number.parseInt(event.target.dataset.index, 10);

    if (role === 'folder' && Number.isInteger(index) && state.categoryDrafts[index]) {
      state.categoryDrafts[index].folder = event.target.value;
      state.categoryDirty = true;
    }
  });

  elements.categoryList.addEventListener('click', (event) => {
    const role = event.target.dataset.role;
    const index = Number.parseInt(event.target.dataset.index, 10);

    if (role === 'remove' && Number.isInteger(index)) {
      state.categoryDrafts.splice(index, 1);
      state.categoryDirty = true;
      renderCategoryManager();
    }
  });
}

async function bootstrap() {
  bindEvents();
  await refreshAll(true);
  window.setInterval(() => {
    void refreshAll(false);
  }, 30000);
}

bootstrap().catch((error) => {
  elements.detailView.className = 'detail-view empty-state';
  elements.detailView.textContent = error.message;
});
