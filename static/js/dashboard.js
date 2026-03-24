/* ═══════════════════════════════════════════════════════════════════════════
   DataLens Dashboard — dashboard.js
   Handles: GridStack, Widget CRUD, Plotly charts, Filters, Side panels
═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let grid = null;
let widgets = [...INITIAL_WIDGETS];
let datasets = [...INITIAL_DATASETS];
let currentMode = 'edit';

// Wizard state
let wizardChartType = null;
let wizardPalette = 'default';

// Edit state
let editingWidgetUid = null;
let editFilters = [];        // additional widget filters (on top of dashboard)
let editCustomFilters = [];  // override filters (when use_dashboard_filters=false)
let editPalette = 'default';

// Add wizard filters
let addFilters = [];

// Dashboard-level filters: array of { id, dataset_id, column, operator, value }
// These are applied to every widget that has use_dashboard_filters !== false
let dashboardFilters = (typeof INITIAL_DASHBOARD_FILTERS !== 'undefined') ? INITIAL_DASHBOARD_FILTERS : [];
let dashFilterEditing = []; // working copy inside the panel

// Color palettes
const PALETTES = {
  default: ['#6366f1','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#ef4444','#3b82f6'],
  ocean:   ['#06b6d4','#0ea5e9','#6366f1','#818cf8','#38bdf8','#7dd3fc','#a5f3fc','#bae6fd'],
  forest:  ['#10b981','#34d399','#6ee7b7','#059669','#047857','#065f46','#14b8a6','#2dd4bf'],
  sunset:  ['#f59e0b','#ef4444','#ec4899','#f97316','#eab308','#84cc16','#fb7185','#fbbf24'],
  mono:    ['#1e293b','#334155','#475569','#64748b','#94a3b8','#cbd5e1','#e2e8f0','#f1f5f9'],
};

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGrid();
  renderAllWidgets();
  initUploadZone();
  populateDatasetSelects();
  checkCanvasEmpty();
  updateTransformBtn();
  _updateDashFilterBadge(); // reflect filters loaded from server
});

function initGrid() {
  grid = GridStack.init({
    cellHeight: 80,
    margin: 12,
    animate: true,
    resizable: { handles: 'se' },
    draggable: { handle: '.widget-header' },
    float: false,
  }, '#grid');

  grid.on('change', debounce(saveAllLayouts, 800));
}

function checkCanvasEmpty() {
  const empty = document.getElementById('canvasEmpty');
  if (!empty) return;
  empty.style.display = widgets.length === 0 ? 'flex' : 'none';
}

// ── Mode ───────────────────────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  const page = document.getElementById('dashboardPage');
  page.classList.toggle('view-mode', mode === 'view');
  document.getElementById('editModeBtn').classList.toggle('active', mode === 'edit');
  document.getElementById('viewModeBtn').classList.toggle('active', mode === 'view');

  // Enable/disable grid drag&resize
  if (mode === 'view') {
    grid.disable();
  } else {
    grid.enable();
  }
}

// ── Title edit ─────────────────────────────────────────────────────────────
function editTitle() {
  const title = document.getElementById('dashTitle');
  const current = title.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = 'font-family:inherit;font-size:inherit;font-weight:inherit;background:var(--bg3);border:1px solid var(--accent);border-radius:6px;padding:2px 8px;color:var(--text);width:250px;';
  title.replaceWith(input);
  input.focus(); input.select();

  const save = () => {
    const newName = input.value.trim() || current;
    const h2 = document.createElement('h2');
    h2.id = 'dashTitle'; h2.className = 'dash-title'; h2.textContent = newName;
    input.replaceWith(h2);
    if (newName !== current) {
      fetch(`/api/dashboard/${DASHBOARD_UID}/rename`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name: newName})
      });
    }
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { input.value = current; save(); } });
}

// ── Panels ─────────────────────────────────────────────────────────────────
function openPanel(id) {
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
  document.getElementById(id).classList.add('open');
  document.getElementById('panelOverlay').style.display = 'block';
}

function closeAllPanels() {
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
  document.getElementById('panelOverlay').style.display = 'none';
}

function closePanel() { closeAllPanels(); }
function closeEditPanel() { closeAllPanels(); editingWidgetUid = null; }
function closeUploadPanel() { closeAllPanels(); }

// ── Widget Wizard ──────────────────────────────────────────────────────────
function openWidgetWizard() {
  // Reset state
  wizardChartType = null;
  wizardPalette = 'default';
  addFilters = [];
  document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('toStep2Btn').disabled = true;
  document.getElementById('widgetTitle').value = '';
  document.getElementById('datasetSelect').value = '';
  document.getElementById('axisConfig').style.display = 'none';
  document.getElementById('filtersList').innerHTML = '';
  document.getElementById('previewBox').innerHTML = '<div class="preview-placeholder"><i class="fa fa-chart-bar"></i> Preview will appear here</div>';
  selectPalette('default');
  panelGoStep(1);
  openPanel('widgetPanel');
}

function selectChartType(type) {
  wizardChartType = type;
  document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.toggle('selected', b.dataset.type === type));
  document.getElementById('toStep2Btn').disabled = false;
  updateAxisLabels(type, 'xAxisLabel', 'yAxisLabel', 'kpiConfig', 'axisConfig', 'xAxisGroup', 'yAxisGroup');
  updateWizardStyleControls(type);
}

function updateAxisLabels(type, xLabelId, yLabelId, kpiId, axisId, xGrpId, yGrpId) {
  const kpiTypes = ['kpi'];
  const noAxisTypes = ['kpi', 'table'];
  if (document.getElementById(kpiId)) {
    document.getElementById(kpiId).style.display = (type === 'kpi') ? 'block' : 'none';
  }
  if (xGrpId && document.getElementById(xGrpId)) {
    document.getElementById(xGrpId).style.display = noAxisTypes.includes(type) ? 'none' : 'block';
  }
  if (yGrpId && document.getElementById(yGrpId)) {
    document.getElementById(yGrpId).style.display = noAxisTypes.includes(type) ? 'none' : 'block';
  }
  const xLabel = document.getElementById(xLabelId);
  const yLabel = document.getElementById(yLabelId);
  if (!xLabel || !yLabel) return;
  if (type === 'scatter') { xLabel.textContent = 'X Axis (numeric)'; yLabel.textContent = 'Y Axis (numeric)'; }
  else if (type === 'pie' || type === 'donut') { xLabel.textContent = 'Labels'; yLabel.textContent = 'Values'; }
  else { xLabel.textContent = 'X Axis / Category'; yLabel.textContent = 'Y Axis / Value'; }
}

function panelGoStep(n) {
  ['panel-step-1','panel-step-2','panel-step-3'].forEach((id, i) => {
    document.getElementById(id).style.display = (i + 1 === n) ? 'flex' : 'none';
    document.getElementById(id).style.flexDirection = 'column';
  });
  ['ps1','ps2','ps3'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.toggle('active', i + 1 === n);
    el.classList.toggle('done', i + 1 < n);
  });
  document.getElementById('panelSubtitle').textContent = `Step ${n} of 3`;

  if (n === 3) {
    // Re-apply style control visibility now that step 3 DOM is visible
    updateWizardStyleControls(wizardChartType);
    generatePreview();
  }
}

function onDatasetChange() {
  const dsId = parseInt(document.getElementById('datasetSelect').value);
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) { document.getElementById('axisConfig').style.display = 'none'; return; }
  document.getElementById('axisConfig').style.display = 'block';
  populateWizardColumns(ds);
  updateAxisLabels(wizardChartType, 'xAxisLabel', 'yAxisLabel', 'kpiConfig', 'axisConfig', 'xAxisGroup', 'yAxisGroup');
  // Pre-fetch column values so _isDateColumn can detect date columns
  // without requiring the user to open a filter first.
  _prefetchColumnValues(ds).then(() => {
    _updateDateGroupVisibility(
      document.getElementById('xAxisSelect').value,
      ds.id, 'dateGroupSelect', 'dateGroupRow'
    );
  });
}

// Return true if colName should be treated as a date column.
// Checks (in order): transformState config, columns_meta type, and
// as a last resort runs looksLikeDates against the cached column values.
function _isDateColumn(ds, colName) {
  if (!ds || !colName) return false;
  // 1. User explicitly marked it as date via Transform panel
  const t = transformState[ds.id];
  if (t && t[colName] && t[colName].type === 'date') return true;
  // 2. columns_meta flagged it as date at upload time (only happens for
  //    native Excel date cells — rare for string-formatted dates)
  const col = ds.columns.find(c => c.name === colName);
  if (col && col.type === 'date') return true;
  // 3. Check the value cache if available — avoids a round-trip
  const cacheKey = ds.id + ':' + colName;
  const cached = _colValuesCache[cacheKey];
  if (cached && cached.length) return looksLikeDates(cached.slice(0, 60));
  return false;
}

function _updateDateGroupVisibility(xCol, dsId, groupSelectId, groupRowId) {
  const ds = datasets.find(d => d.id === dsId);
  const isDate = _isDateColumn(ds, xCol);
  const row = document.getElementById(groupRowId);
  if (row) row.style.display = isDate ? 'block' : 'none';
  if (!isDate) {
    const sel = document.getElementById(groupSelectId);
    if (sel) sel.value = '';
  }
}

// Called when the aggregation dropdown changes in the wizard —
// updates the Y axis label to hint distinct_count accepts any column.
function onWizardAggChange() {
  const agg = document.getElementById('aggregationSelect').value;
  const yLabel = document.getElementById('yAxisLabel');
  if (yLabel) {
    if (agg === 'distinct_count') {
      yLabel.textContent = 'Count Distinct of (any column)';
    } else if (!['kpi','table','pie','donut'].includes(wizardChartType)) {
      yLabel.textContent = 'Values (Y Axis)';
    }
  }
}

function onEditAggChange() {
  const agg = document.getElementById('editAggSelect').value;
  const yLabel = document.getElementById('editYLabel');
  if (yLabel) {
    yLabel.textContent = agg === 'distinct_count'
      ? 'Count Distinct of (any column)'
      : 'Values (Y Axis)';
  }
}

function onWizardAxisChange() {
  const dsId = parseInt(document.getElementById('datasetSelect').value);
  const ds = datasets.find(d => d.id === dsId);
  if (ds) populateSeriesSelect(ds, 'seriesSelect', document.getElementById('xAxisSelect').value);
  const xCol = document.getElementById('xAxisSelect').value;
  // Run immediately (may use cache), then re-run after prefetch completes
  _updateDateGroupVisibility(xCol, dsId, 'dateGroupSelect', 'dateGroupRow');
  if (ds) _prefetchColumnValues(ds).then(() =>
    _updateDateGroupVisibility(xCol, dsId, 'dateGroupSelect', 'dateGroupRow')
  );
}

function onEditAxisChange() {
  const dsId = parseInt(document.getElementById('editDatasetSelect').value);
  const ds = datasets.find(d => d.id === dsId);
  if (ds) populateSeriesSelect(ds, 'editSeriesSelect', document.getElementById('editXSelect').value);
  const xCol = document.getElementById('editXSelect').value;
  _updateDateGroupVisibility(xCol, dsId, 'editDateGroupSelect', 'editDateGroupRow');
  if (ds) _prefetchColumnValues(ds).then(() =>
    _updateDateGroupVisibility(xCol, dsId, 'editDateGroupSelect', 'editDateGroupRow')
  );
}

function populateWizardColumns(ds) {
  const cols = ds.columns;
  const numCols = cols.filter(c => c.type === 'numeric');

  // X axis - all columns
  const xSel = document.getElementById('xAxisSelect');
  xSel.innerHTML = cols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  // Y columns wrap - all columns shown; default selection = first numeric
  const yWrap = document.getElementById('yColsWrap');
  yWrap.innerHTML = '';
  const firstY = (numCols[0] || cols[1] || cols[0])?.name || '';
  yWrap.appendChild(makeYColRow(cols, firstY, false));

  // Series select
  populateSeriesSelect(ds, 'seriesSelect', xSel.value);

  // KPI - all columns (distinct_count can target any column)
  const kpiSel = document.getElementById('kpiColumnSelect');
  kpiSel.innerHTML = cols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  // Secondary axis column select
  const y2Sel = document.getElementById('y2ColSelect');
  if (y2Sel) {
    y2Sel.innerHTML = '<option value="">— None (no secondary axis) —</option>' +
      cols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  }
}

function makeYColRow(cols, selected, removable) {
  const wrap = document.createElement('div');
  wrap.className = 'y-col-row';
  const sel = document.createElement('select');
  sel.className = 'y-col-select';
  // Always show ALL columns — distinct_count works on any column type
  sel.innerHTML = cols.map(c => `<option value="${c.name}" ${c.name===selected?'selected':''}>${c.name}</option>`).join('');
  wrap.appendChild(sel);
  if (removable) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'icon-btn danger'; btn.innerHTML = '<i class="fa fa-times"></i>';
    btn.onclick = () => wrap.remove();
    wrap.appendChild(btn);
  }
  return wrap;
}

function addYColumn() {
  const dsId = parseInt(document.getElementById('datasetSelect').value);
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  const numCols = ds.columns.filter(c => c.type === 'numeric');
  const defaultCol = (numCols[0] || ds.columns[0])?.name || '';
  // makeYColRow always renders all columns so distinct_count can pick any
  document.getElementById('yColsWrap').appendChild(makeYColRow(ds.columns, defaultCol, true));
}

function addEditYColumn() {
  const dsId = parseInt(document.getElementById('editDatasetSelect').value);
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  const numCols = ds.columns.filter(c => c.type === 'numeric');
  const defaultCol = (numCols[0] || ds.columns[0])?.name || '';
  document.getElementById('editYColsWrap').appendChild(makeYColRow(ds.columns, defaultCol, true));
}

function populateSeriesSelect(ds, selectId, excludeCol) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const curVal = sel.value;
  sel.innerHTML = '<option value="">— None —</option>' +
    ds.columns.filter(c => c.name !== excludeCol).map(c =>
      `<option value="${c.name}" ${c.name===curVal?'selected':''}>${c.name}</option>`
    ).join('');
}

function populateColumnSelects(ds, xId, yId, kpiId) {
  // Legacy – still called in a few places, delegates to new helpers
  const cols = ds.columns;
  const numericCols = cols.filter(c => c.type === 'numeric');
  const allCols = cols;
  [xId].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = allCols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  });
  [yId, kpiId].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Show all columns — distinct_count works on text columns too
    el.innerHTML = allCols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  });
  renderFilterColumnOptions(cols, 'filtersList', addFilters);
}

// ── Filter operators ────────────────────────────────────────────────────────
const FILTER_OPS = [
  { value: 'equals',        label: '= Equals',           hasValue: true,  multi: true  },
  { value: 'not_equals',    label: '≠ Not equals',       hasValue: true,  multi: true  },
  { value: 'contains',      label: '⊃ Contains',         hasValue: true,  multi: true  },
  { value: 'not_contains',  label: '⊅ Not contains',     hasValue: true,  multi: true  },
  { value: 'greater_than',  label: '> Greater than',     hasValue: true,  multi: false },
  { value: 'less_than',     label: '< Less than',        hasValue: true,  multi: false },
  { value: 'greater_equal', label: '≥ Greater or equal', hasValue: true,  multi: false },
  { value: 'less_equal',    label: '≤ Less or equal',    hasValue: true,  multi: false },
  { value: 'in',            label: '∈ Is one of',        hasValue: true,  multi: true  },
  { value: 'not_in',        label: '∉ Is not one of',    hasValue: true,  multi: true  },
  { value: 'is_null',       label: '∅ Is empty',         hasValue: false, multi: false },
  { value: 'is_not_null',   label: '◉ Is not empty',     hasValue: false, multi: false },
];
// Operators that still use a plain single input (numeric comparisons)
const SINGLE_VALUE_OPS = new Set(['greater_than','less_than','greater_equal','less_equal']);

// Cache unique column values per dataset+column
const _colValuesCache = {};

// Pre-fetch values for all columns in a dataset in the background so that
// _isDateColumn can use the cache without requiring a filter interaction first.
async function _prefetchColumnValues(ds) {
  if (!ds) return;
  for (const col of ds.columns) {
    // Don't await — fire and forget, we just want the cache populated
    fetchColumnValues(ds.id, col.name).catch(() => {});
  }
}

async function fetchColumnValues(datasetId, colName) {
  const key = `${datasetId}:${colName}`;
  if (_colValuesCache[key]) return _colValuesCache[key];
  try {
    const res = await fetch(`/api/dataset/${datasetId}/data?limit=5000`);
    const data = await res.json();
    if (data.error) return [];
    const idx = data.columns.indexOf(colName);
    if (idx < 0) return [];
    const unique = [...new Set(data.data.map(r => r[idx]).filter(v => v !== null && v !== undefined))]
      .map(String).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    _colValuesCache[key] = unique;
    return unique;
  } catch { return []; }
}

function getFilterDatasetId(containerId) {
  const selId = (containerId === 'filtersList') ? 'datasetSelect' : 'editDatasetSelect';
  return parseInt(document.getElementById(selId)?.value) || null;
}

function addFilter() {
  const dsId = getFilterDatasetId('filtersList');
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  addFilters.push({ id: Date.now(), column: ds.columns[0]?.name || '', operator: 'equals', value: '' });
  renderFilters('filtersList', addFilters, ds.columns);
}

function addEditFilter() {
  const dsId = getFilterDatasetId('editFiltersList');
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  editFilters.push({ id: Date.now(), column: ds.columns[0]?.name || '', operator: 'equals', value: '' });
  renderFilters('editFiltersList', editFilters, ds.columns);
}

function addEditCustomFilter() {
  const dsId = getFilterDatasetId('editCustomFiltersList');
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  editCustomFilters.push({ id: Date.now(), column: ds.columns[0]?.name || '', operator: 'equals', value: '' });
  renderFilters('editCustomFiltersList', editCustomFilters, ds.columns);
}

function _updateEditFilterSections(useDash) {
  const dashSection  = document.getElementById('editDashFilterSection');
  const addSection   = document.getElementById('editAdditionalFilterSection');
  const customSection = document.getElementById('editCustomFilterSection');
  if (dashSection)   dashSection.style.display   = useDash ? 'block' : 'none';
  if (addSection)    addSection.style.display     = useDash ? 'block' : 'none';
  if (customSection) customSection.style.display  = useDash ? 'none'  : 'block';
}

function renderFilters(containerId, filtersArr, columns) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Build a quick lookup of which columns are date-typed according to transformState.
  // This lets us show a format hint without any extra API call.
  const dsSelId = containerId === 'filtersList' ? 'datasetSelect' : 'editDatasetSelect';
  const dsId = parseInt(document.getElementById(dsSelId)?.value) || null;
  const dsTransforms = (dsId && transformState[dsId]) ? transformState[dsId] : {};
  const dsObj = dsId ? datasets.find(d => d.id === dsId) : null;
  const _isDateCol = (colName) => {
    // Check explicit transform
    if (dsTransforms[colName]?.type === 'date') return true;
    // Check columns_meta type
    const colMeta = dsObj?.columns?.find(c => c.name === colName);
    if (colMeta?.type === 'date') return true;
    // Check cached values for date-like strings
    const cached = _colValuesCache[`${dsId}:${colName}`];
    if (cached?.length) return looksLikeDates(cached.slice(0, 30));
    return false;
  };

  container.innerHTML = filtersArr.map((f, idx) => {
    const op = FILTER_OPS.find(o => o.value === f.operator) || FILTER_OPS[0];
    const inputId = `fi-${containerId}-${idx}`;
    const suggestId = `fs-${containerId}-${idx}`;
    const colIsDate = _isDateCol(f.column);

    // Build a small format hint for date columns so users know what to type.
    const dateHint = colIsDate
      ? `<div style="font-size:11px;color:var(--text3);margin-top:2px;font-style:italic">
           📅 Use YYYY-MM-DD format, e.g. 2024-01-31
         </div>`
      : '';

    let valueHtml = '';
    if (op.hasValue) {
      if (SINGLE_VALUE_OPS.has(op.value)) {
        const val = Array.isArray(f.value) ? (f.value[0] || '') : (f.value || '');
        if (colIsDate) {
          // Date column: show a native date picker — no typing, no ambiguity
          valueHtml = `
            <input class="filter-val" id="${inputId}" type="date" value="${escapeHtml(String(val))}"
              onchange="onFilterSingleBlur(this,'${containerId}',${idx},'${suggestId}')"
              style="flex:1;color-scheme:dark" />`;
        } else {
          // Numeric column: plain text input with autocomplete
          valueHtml = `
            <div class="filter-ac-wrap">
              <input class="filter-val" id="${inputId}" type="text" placeholder="Value" value="${escapeHtml(String(val))}"
                oninput="onFilterInput(this,'${containerId}',${idx},'${suggestId}')"
                onkeydown="onFilterKeydown(event,'${containerId}',${idx},'${suggestId}','${inputId}')"
                onblur="onFilterSingleBlur(this,'${containerId}',${idx},'${suggestId}')"
                autocomplete="off" />
              <div class="filter-suggestions" id="${suggestId}"></div>
            </div>`;
        }
      } else {
        // Tag input: type + Enter or click suggestion to add values
        const tags = Array.isArray(f.value) ? f.value
          : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
        const placeholder = tags.length ? '' : (colIsDate ? 'YYYY-MM-DD &amp; Enter…' : 'Type &amp; Enter to add…');
        const tagsHtml = tags.map((t, ti) =>
          `<span class="filter-tag">${escapeHtml(t)}<button type="button" tabindex="-1"
            onmousedown="removeFilterTag('${containerId}',${idx},${ti},event)">×</button></span>`
        ).join('');
        valueHtml = `
          <div class="filter-tags-wrap" onclick="document.getElementById('${inputId}').focus()">
            ${tagsHtml}
            <div class="filter-ac-wrap">
              <input class="filter-tag-input" id="${inputId}" type="text" placeholder="${placeholder}"
                oninput="onFilterInput(this,'${containerId}',${idx},'${suggestId}')"
                onkeydown="onFilterKeydown(event,'${containerId}',${idx},'${suggestId}','${inputId}')"
                onblur="if(!_suggestMousedown) hideFilterSuggest('${suggestId}',0)"
                autocomplete="off" />
              <div class="filter-suggestions" id="${suggestId}"></div>
            </div>
          </div>
          ${dateHint}`;
      }
    } else {
      valueHtml = `<span class="filter-val-empty"></span>`;
    }

    return `
      <div class="filter-row" data-id="${f.id}">
        <select class="filter-col" onchange="updateFilter('${containerId}',${idx},'column',this.value)">
          ${columns.map(c => `<option value="${c.name}" ${c.name === f.column ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
        <select class="filter-op" onchange="updateFilter('${containerId}',${idx},'operator',this.value)">
          ${FILTER_OPS.map(o => `<option value="${o.value}" ${o.value === f.operator ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        ${valueHtml}
        <button class="icon-btn danger" onclick="removeFilter('${containerId}',${idx})"><i class="fa fa-times"></i></button>
      </div>`;
  }).join('');
}

// ── Autocomplete ─────────────────────────────────────────────────────────────
async function onFilterInput(input, containerId, idx, suggestId) {
  const arr = _getFilterArr(containerId);
  const f = arr[idx];
  if (!f) return;
  const op = FILTER_OPS.find(o => o.value === f.operator);
  if (op && SINGLE_VALUE_OPS.has(op.value)) arr[idx].value = input.value; // sync plain inputs only
  const query = input.value.trim().toLowerCase();
  const dsId = getFilterDatasetId(containerId);
  if (!dsId) return;
  const allVals = await fetchColumnValues(dsId, f.column);
  const filtered = allVals.filter(v => !query || v.toLowerCase().includes(query)).slice(0, 10);
  showFilterSuggestions(suggestId, filtered, containerId, idx, input.id);
}

// Track whether a suggestion mousedown is in progress — prevents blur from
// closing the dropdown before the click event fires (blur fires before mouseup)
let _suggestMousedown = false;

function onFilterSingleBlur(input, containerId, idx, suggestId) {
  const arr = _getFilterArr(containerId);
  if (arr[idx]) arr[idx].value = input.value;
  // Only hide if the user didn't click a suggestion item
  if (!_suggestMousedown) hideFilterSuggest(suggestId, 0);
}

function onFilterKeydown(e, containerId, idx, suggestId, inputId) {
  const suggest = document.getElementById(suggestId);
  const hasActiveSuggestion = suggest && suggest.querySelector('.suggest-item.active');

  if (e.key === 'Enter') {
    e.preventDefault();
    if (hasActiveSuggestion) {
      // Confirm the highlighted suggestion
      hasActiveSuggestion.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    } else {
      // No suggestion highlighted — commit whatever is typed directly
      const input = document.getElementById(inputId);
      const val = input?.value?.trim();
      if (val) {
        applyFilterSuggestion(containerId, idx, suggestId, inputId, val);
      }
    }
    return;
  }

  if (!suggest || !suggest.children.length) return;
  const items = suggest.querySelectorAll('.suggest-item');
  let active = suggest.querySelector('.suggest-item.active');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = active ? (active.nextElementSibling || items[0]) : items[0];
    active && active.classList.remove('active');
    next && next.classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = active ? (active.previousElementSibling || items[items.length-1]) : items[items.length-1];
    active && active.classList.remove('active');
    prev && prev.classList.add('active');
  } else if (e.key === 'Escape') {
    hideFilterSuggest(suggestId, 0);
  }
}

function showFilterSuggestions(suggestId, values, containerId, idx, inputId) {
  const suggest = document.getElementById(suggestId);
  if (!suggest) return;
  if (!values.length) { suggest.innerHTML = ''; return; }

  // Use pointerdown so selection fires before blur, avoiding the blur/click race entirely.
  // We store the value in a closure via addEventListener (not inline HTML) to avoid
  // quoting/escaping issues with special characters in column values.
  suggest.innerHTML = values.map(v => `<div class="suggest-item">${escapeHtml(v)}</div>`).join('');

  suggest.querySelectorAll('.suggest-item').forEach((el, i) => {
    const v = values[i];
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();          // prevents input blur from firing
      _suggestMousedown = true;
      applyFilterSuggestion(containerId, idx, suggestId, inputId, v);
      _suggestMousedown = false;
    });
  });
}

function selectFilterSuggestion(e, containerId, idx, suggestId, inputId, value) {
  // kept for keyboard Enter path
  e.preventDefault();
  _suggestMousedown = false;
  applyFilterSuggestion(containerId, idx, suggestId, inputId, value);
}

function applyFilterSuggestion(containerId, idx, suggestId, inputId, value) {
  const arr = _getFilterArr(containerId);
  const f = arr[idx];
  if (!f) return;
  const op = FILTER_OPS.find(o => o.value === f.operator);
  if (op && !SINGLE_VALUE_OPS.has(op.value)) {
    // Tag mode: add value as a new tag
    const current = Array.isArray(f.value) ? [...f.value]
      : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
    if (!current.includes(value)) { current.push(value); arr[idx].value = current; }
    const input = document.getElementById(inputId);
    if (input) { input.value = ''; input.focus(); }
    hideFilterSuggest(suggestId, 0);
    const dsId = getFilterDatasetId(containerId);
    const ds = datasets.find(d => d.id === dsId);
    if (ds) renderFilters(containerId, arr, ds.columns);
  } else {
    // Single value mode
    arr[idx].value = value;
    const input = document.getElementById(inputId);
    if (input) input.value = value;
    hideFilterSuggest(suggestId, 0);
  }
}

function removeFilterTag(containerId, idx, tagIdx, event) {
  event.preventDefault(); event.stopPropagation();
  const arr = _getFilterArr(containerId);
  const f = arr[idx];
  if (!f) return;
  const current = Array.isArray(f.value) ? [...f.value]
    : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
  current.splice(tagIdx, 1);
  arr[idx].value = current;
  const dsId = getFilterDatasetId(containerId);
  const ds = datasets.find(d => d.id === dsId);
  if (ds) renderFilters(containerId, arr, ds.columns);
}

function hideFilterSuggest(suggestId, delay) {
  if (delay === 0) {
    const el = document.getElementById(suggestId);
    if (el) el.innerHTML = '';
  } else {
    setTimeout(() => {
      if (_suggestMousedown) return; // don't hide if user is clicking a suggestion
      const el = document.getElementById(suggestId);
      if (el) el.innerHTML = '';
    }, delay);
  }
}

function _getFilterArr(containerId) {
  if (containerId === 'filtersList') return addFilters;
  if (containerId === 'editCustomFiltersList') return editCustomFilters;
  return editFilters;
}

function updateFilter(containerId, idx, key, value) {
  const arr = _getFilterArr(containerId);
  arr[idx][key] = value;
  if (key === 'operator' || key === 'column') {
    if (key === 'column') arr[idx].value = '';
    const dsId = getFilterDatasetId(containerId);
    const ds = datasets.find(d => d.id === dsId);
    if (ds) renderFilters(containerId, arr, ds.columns);
  }
}

function removeFilter(containerId, idx) {
  const arr = _getFilterArr(containerId);
  arr.splice(idx, 1);
  const dsId = getFilterDatasetId(containerId);
  const ds = datasets.find(d => d.id === dsId);
  if (ds) renderFilters(containerId, arr, ds.columns);
}

function renderFilterColumnOptions(cols, containerId, filtersArr) {
  renderFilters(containerId, filtersArr, cols);
}

// Normalize filter values before sending to server
function normalizeFilters(filters) {
  return filters.filter(f => {
    const op = FILTER_OPS.find(o => o.value === f.operator);
    if (!op) return false;
    if (!op.hasValue) return true;
    const v = Array.isArray(f.value) ? f.value.join(',') : f.value;
    return v !== '' && v !== null && v !== undefined;
  }).map(f => {
    // Always serialize as comma-separated string for server
    // Only send the fields the server expects — strip client-only fields
    const val = Array.isArray(f.value) ? f.value.join(',') : f.value;
    return { column: f.column, operator: f.operator, value: val };
  });
}


function selectPalette(name) {
  wizardPalette = name;
  document.querySelectorAll('#palettePicker .palette-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.palette === name);
  });
}

function selectEditPalette(name) {
  editPalette = name;
  document.querySelectorAll('#editPalettePicker .palette-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.palette === name);
  });
}

async function generatePreview() {
  const dsId = parseInt(document.getElementById('datasetSelect').value);
  if (!dsId || !wizardChartType || wizardChartType === 'kpi') {
    document.getElementById('previewBox').innerHTML = '<div class="preview-placeholder"><i class="fa fa-chart-bar"></i> Select data to see preview</div>';
    return;
  }

  const config = buildWizardConfig();
  const filters = normalizeFilters(addFilters);
  const url = `/api/dataset/${dsId}/data?limit=200${filters.length ? '&filters=' + encodeURIComponent(JSON.stringify(filters)) : ''}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const previewBox = document.getElementById('previewBox');
    previewBox.innerHTML = '';
    const div = document.createElement('div');
    div.style.width = '100%'; div.style.height = '200px';
    previewBox.appendChild(div);

    renderPlotly(div, wizardChartType, data, config);
  } catch (e) {
    document.getElementById('previewBox').innerHTML = `<div class="preview-placeholder" style="color:var(--danger)"><i class="fa fa-exclamation-triangle"></i> ${e.message}</div>`;
  }
}

function val(id, fallback = '') {
  return document.getElementById(id)?.value ?? fallback;
}
function checked(id, fallback = false) {
  return document.getElementById(id)?.checked ?? fallback;
}

function buildWizardConfig() {
  const yCols = getWizardYCols();
  return {
    x_column:      val('xAxisSelect'),
    y_columns:     yCols,
    y_column:      yCols[0] || '',
    series_column: val('seriesSelect'),
    aggregation:   val('aggregationSelect', 'none'),
    date_group:    val('dateGroupSelect', ''),
    sort:          val('sortSelect'),
    bar_mode:      val('barModeSelect', 'group'),
    line_style:    val('lineStyleSelect', 'linear'),
    show_markers:  checked('showMarkers', true),
    kpi_column:    val('kpiColumnSelect'),
    kpi_agg:       val('kpiAggSelect', 'sum'),
    kpi_formula:   document.getElementById('kpiModeFormula')?.classList.contains('active') ? val('kpiFormula') : '',
    kpi_decimals:  val('kpiDecimals', 'auto'),
    kpi_prefix:    val('kpiPrefix'),
    kpi_suffix:    val('kpiSuffix'),
    palette:       wizardPalette,
    show_legend:   checked('showLegend', true),
    show_labels:   checked('showLabels', false),
    y2_column:     val('y2ColSelect', ''),
    y2_aggregation: val('y2AggSelect', 'sum'),
    y1_title:      val('y1TitleInput', ''),
    y2_title:      val('y2TitleInput', ''),
    filters:       normalizeFilters(addFilters),
  };
}

function getWizardYCols() {
  return [...document.querySelectorAll('#yColsWrap .y-col-select')].map(s => s.value).filter(Boolean);
}

function getEditYCols() {
  return [...document.querySelectorAll('#editYColsWrap .y-col-select')].map(s => s.value).filter(Boolean);
}

async function saveWidget() {
  const btn = document.getElementById('saveWidgetBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Saving...';

  try {
    const dsId = val('datasetSelect');
    const title = val('widgetTitle') || (wizardChartType
      ? wizardChartType.charAt(0).toUpperCase() + wizardChartType.slice(1) + ' Chart'
      : 'New Widget');
    const sizeMap = { small:{w:3,h:3}, medium:{w:6,h:4}, large:{w:9,h:5}, full:{w:12,h:5} };
    const size = sizeMap[val('widgetSize')] || {w:6,h:4};

    const config = buildWizardConfig();

    const payload = {
      title,
      chart_type: wizardChartType,
      dataset_id: dsId ? parseInt(dsId) : null,
      config,
      layout: { x:0, y:0, ...size }
    };

    const res = await fetch(`/api/dashboard/${DASHBOARD_UID}/widget`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (result.uid) {
      payload.id = result.id;
      payload.uid = result.uid;
      widgets.push(payload);
      await addWidgetToGrid(payload);
      checkCanvasEmpty();
      closeAllPanels();
    } else {
      throw new Error(result.error || 'Server returned no widget ID');
    }
  } catch(e) {
    console.error('saveWidget error:', e);
    alert('Error saving widget: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa fa-check"></i> Add to Dashboard';
  }
}

// ── Grid & Rendering ───────────────────────────────────────────────────────
function renderAllWidgets() {
  widgets.forEach(w => addWidgetToGrid(w));
}

async function addWidgetToGrid(w) {
  const layout = w.layout || { x:0, y:0, w:6, h:4 };
  const el = document.createElement('div');
  el.className = 'grid-stack-item';
  el.setAttribute('gs-x', layout.x); el.setAttribute('gs-y', layout.y);
  el.setAttribute('gs-w', layout.w); el.setAttribute('gs-h', layout.h);
  el.setAttribute('gs-id', w.uid);

  el.innerHTML = `
    <div class="grid-stack-item-content">
      <div class="widget-card" id="wcard-${w.uid}">
        <div class="widget-header">
          <span class="widget-title">${escapeHtml(w.title)}</span>
          <div class="widget-actions">
            <button class="icon-btn" onclick="openConvertWidget('${w.uid}')" title="Convert to chart"><i class="fa fa-chart-bar"></i></button>
            <button class="icon-btn" onclick="openEditWidget('${w.uid}')" title="Edit"><i class="fa fa-pen"></i></button>
            <button class="icon-btn danger" onclick="deleteWidget('${w.uid}')" title="Delete"><i class="fa fa-trash"></i></button>
          </div>
        </div>
        <div class="widget-body" id="wbody-${w.uid}">
          <div class="widget-loading"><i class="fa fa-spinner fa-spin"></i> Loading...</div>
        </div>
      </div>
    </div>`;

  grid.addWidget(el);
  await renderWidget(w);
}

async function renderWidget(w) {
  const body = document.getElementById(`wbody-${w.uid}`);
  if (!body) return;

  if (!w.dataset_id) {
    body.innerHTML = '<div class="widget-error"><i class="fa fa-database"></i> No data source selected<br><small>Click edit to configure</small></div>';
    return;
  }

  body.innerHTML = '<div class="widget-loading"><i class="fa fa-spinner fa-spin"></i></div>';

  const config = w.config || {};

  // Build effective filter list:
  //   1. Dashboard-level filters matching this widget's dataset (if use_dashboard_filters !== false)
  //   2. Widget-specific additional filters (always applied on top)
  //   3. If use_dashboard_filters === false → only widget custom_filters are used (overrides dashboard)
  const useDashFilters = config.use_dashboard_filters !== false;
  const dashFiltersForDs = useDashFilters
    ? normalizeFilters(dashboardFilters.filter(f => f.dataset_id === w.dataset_id))
    : [];
  const widgetFilters = useDashFilters
    ? normalizeFilters(config.filters || [])           // additional on top of dash
    : normalizeFilters(config.custom_filters || []);   // full override

  const filters = [...dashFiltersForDs, ...widgetFilters];
  const url = `/api/dataset/${w.dataset_id}/data?limit=2000${filters.length ? '&filters=' + encodeURIComponent(JSON.stringify(filters)) : ''}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Enrich config with date_trunc from the dataset's column metadata so that
    // _pickTickformat() can select the right Plotly tick format automatically.
    const enrichedConfig = _enrichConfigWithDateMeta(config, w.dataset_id);

    body.innerHTML = '';

    if (w.chart_type === 'kpi') {
      renderKPI(body, data, enrichedConfig);
    } else if (w.chart_type === 'table') {
      renderTable(body, data, enrichedConfig);
    } else {
      const div = document.createElement('div');
      div.className = 'widget-plot'; div.style.height = '100%';
      body.appendChild(div);
      renderPlotly(div, w.chart_type, data, enrichedConfig);
    }
  } catch (e) {
    body.innerHTML = `<div class="widget-error"><i class="fa fa-exclamation-triangle"></i> ${escapeHtml(e.message)}</div>`;
  }
}

// Look up date_trunc for the x_column from transformState so the tick format
// is always in sync with what the server applied, without any extra API call.
function _enrichConfigWithDateMeta(config, datasetId) {
  if (config.date_trunc) return config; // already set explicitly
  const xCol = config.x_column;
  if (!xCol || !datasetId) return config;
  const transforms = transformState[datasetId] || {};
  const colTransform = transforms[xCol];
  if (colTransform && colTransform.type === 'date' && colTransform.date_trunc) {
    return { ...config, date_trunc: colTransform.date_trunc };
  }
  return config;
}

function getColIndex(columns, name) {
  return columns.indexOf(name);
}

function getColValues(data, columns, colName) {
  const idx = getColIndex(columns, colName);
  if (idx < 0) return [];
  return data.data.map(row => row[idx]);
}

function aggregate(values, method) {
  // distinct_count works on raw (non-numeric) values
  if (method === 'distinct_count') {
    return new Set(values.filter(v => v !== null && v !== undefined && v !== '')).size;
  }
  const nums = values.map(v => parseFloat(v)).filter(v => !isNaN(v));
  if (!nums.length) return 0;
  switch(method) {
    case 'sum':   return nums.reduce((a,b) => a+b, 0);
    case 'avg':   return nums.reduce((a,b) => a+b, 0) / nums.length;
    case 'count': return nums.length;
    case 'min':   return Math.min(...nums);
    case 'max':   return Math.max(...nums);
    default:      return nums;
  }
}

// ── Data engine ────────────────────────────────────────────────────────────

// Patterns that unambiguously look like dates (ordered most-specific first).
// Pure integers like "2024" or "202401" are intentionally excluded.
const DATE_PATTERNS = [
  // ISO 8601 — always safe: 2024-01-31 or 2024-01-31T12:00:00
  /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/,
  // DD/MM/YYYY or MM/DD/YYYY with optional time: 27/06/2025 or 27/06/2025 14:54
  /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/,
  // YYYY/MM/DD with optional time
  /^\d{4}[\/\-\.]\d{2}[\/\-\.]\d{2}(\s+\d{1,2}:\d{2})?$/,
  // "Jan 2024" / "January 2024" / "Jan 31, 2024" / "31 Jan 2024"
  /^(\d{1,2}\s+)?[A-Za-z]{3,9}(\s+\d{1,2},?)?\s+\d{4}$/,
  // "Q1 2024" quarter labels
  /^Q[1-4]\s+\d{4}$/,
];

// Return true if the string matches at least one unambiguous date pattern.
function _matchesDatePattern(str) {
  return DATE_PATTERNS.some(re => re.test(str.trim()));
}

// Detect if a column of values looks like dates.
function looksLikeDates(values) {
  const sample = values
    .filter(v => v !== null && v !== undefined && v !== '')
    .slice(0, 60);
  if (!sample.length) return false;

  // Reject columns where every value is a plain integer
  const allIntegers = sample.every(v => /^\d+$/.test(String(v).trim()));
  if (allIntegers) return false;

  let patternMatches = 0;
  sample.forEach(v => { if (_matchesDatePattern(String(v).trim())) patternMatches++; });

  return (patternMatches / sample.length) >= 0.75;
}

// Parse a value to a Date for sorting.
// Handles ISO strings, named-month strings, quarter labels, and
// DD/MM/YYYY (with or without time) — the last being the most common
// non-ISO format in European data files.
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();

  // ISO 8601 — always unambiguous
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD/MM/YYYY HH:MM[:SS] — must be parsed manually because
  // new Date() treats the first component as MM, giving wrong results for
  // days > 12 and silently swapping month/day for days ≤ 12.
  const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmyMatch) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0'] = dmyMatch;
    // Treat as DD/MM/YYYY if day > 12 (unambiguous), or if the column
    // has already been identified as a date column via transform config.
    // For values where both interpretations are valid (day ≤ 12) we
    // default to DD/MM/YYYY (European convention) — consistent with the
    // dayfirst=True setting used server-side in pandas.
    const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d),
                          parseInt(hh), parseInt(mm), parseInt(ss));
    return isNaN(date.getTime()) ? null : date;
  }

  // "Mon YYYY" / "Month YYYY"
  if (/^[A-Za-z]{3,9}\s+\d{4}$/.test(s)) {
    const d = new Date('1 ' + s);
    return isNaN(d.getTime()) ? null : d;
  }

  // "Q1 2024" quarter labels
  const qm = s.match(/^Q([1-4])\s+(\d{4})$/);
  if (qm) {
    return new Date(parseInt(qm[2]), (parseInt(qm[1]) - 1) * 3, 1);
  }

  // "DD Mon YYYY" / "Mon DD, YYYY"
  if (/^(\d{1,2}\s+)?[A-Za-z]{3,9}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // Last resort
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ── Date truncation helpers ───────────────────────────────────────────────

// Truncate a Date object to a period boundary and return a stable sort key
// (an integer) plus a display label.
function _truncDate(d, period) {
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  const day = d.getDate();
  switch (period) {
    case 'year':
      return { key: y * 10000, label: String(y) };
    case 'quarter': {
      const q = Math.floor(m / 3) + 1;
      return { key: y * 10000 + q * 100, label: `Q${q} ${y}` };
    }
    case 'month':
      return {
        key: y * 10000 + (m + 1) * 100,
        label: d.toLocaleString('en', { month: 'short' }) + ' ' + y,
      };
    case 'week': {
      // ISO week: Monday as first day
      const tmp = new Date(Date.UTC(y, m, day));
      const dow = tmp.getUTCDay() || 7; // Sun=0→7
      tmp.setUTCDate(tmp.getUTCDate() + 1 - dow); // floor to Monday
      const wy = tmp.getUTCFullYear(), wm = tmp.getUTCMonth(), wd = tmp.getUTCDate();
      const label = `${String(wd).padStart(2,'0')} ${tmp.toLocaleString('en',{month:'short'})} ${wy}`;
      return { key: wy * 10000 + wm * 100 + wd, label };
    }
    case 'day':
    default:
      return {
        key: y * 10000 + (m + 1) * 100 + day,
        label: `${String(day).padStart(2,'0')} ${d.toLocaleString('en',{month:'short'})} ${y}`,
      };
  }
}

// Build a grouped map: { xValue: { seriesKey: [yValues] } }
// dateGroup: 'year'|'quarter'|'month'|'week'|'day'|'' — client-side date bucketing
function buildGroupedData(data, xCol, yCol, seriesCol, aggMethod, dateGroup) {
  const cols = data.columns;
  const xIdx = getColIndex(cols, xCol);
  const yIdx = yCol ? getColIndex(cols, yCol) : -1;
  const sIdx = seriesCol ? getColIndex(cols, seriesCol) : -1;

  // When no explicit aggregation is chosen, default to sum so that duplicate
  // X values are collapsed. distinct_count is always passed explicitly.
  const effectiveAgg = (!aggMethod || aggMethod === 'none') ? 'sum' : aggMethod;

  // First pass: detect if X looks like dates (sample raw values)
  const rawSample = data.data.slice(0, 60).map(r => r[xIdx]).filter(v => v != null && v !== '');
  const isDateCol = looksLikeDates(rawSample);
  const doDateGroup = isDateCol && dateGroup && dateGroup !== '';

  // Ordered bucket keys (for stable chronological sort)
  const xOrder = [];       // display labels in insertion order
  const xKeyOrder = [];    // numeric sort keys (only used when doDateGroup)
  const xSet = new Set();  // de-dup by display label
  const seriesSet = new Set();
  const map = {};

  data.data.forEach(row => {
    let xVal = row[xIdx] ?? '(empty)';
    let sortKey = null;

    if (doDateGroup && xVal !== '(empty)') {
      const d = toDate(String(xVal));
      if (d) {
        const { key, label } = _truncDate(d, dateGroup);
        sortKey = key;
        xVal = label;
      }
    }

    const sKey = sIdx >= 0 ? (row[sIdx] ?? '(empty)') : (yCol || 'value');
    const yRaw = yIdx >= 0 ? row[yIdx] : 1;
    const yVal = parseFloat(yRaw);

    if (!xSet.has(xVal)) {
      xSet.add(xVal);
      xOrder.push(xVal);
      xKeyOrder.push(sortKey);
    }
    seriesSet.add(sKey);
    if (!map[xVal]) map[xVal] = {};
    if (!map[xVal][sKey]) map[xVal][sKey] = [];
    // For distinct_count we store raw values; for everything else only numerics
    if (effectiveAgg === 'distinct_count') {
      if (yRaw !== null && yRaw !== undefined && yRaw !== '') map[xVal][sKey].push(yRaw);
    } else {
      if (!isNaN(yVal)) map[xVal][sKey].push(yVal);
    }
  });

  // Sort chronologically when dealing with dates
  if (doDateGroup) {
    // Sort by numeric key
    const paired = xOrder.map((lbl, i) => [lbl, xKeyOrder[i]]);
    paired.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
    xOrder.length = 0;
    paired.forEach(([lbl]) => xOrder.push(lbl));
  } else if (isDateCol) {
    xOrder.sort((a, b) => {
      const da = toDate(a), db = toDate(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  }

  const seriesKeys = [...seriesSet];
  const result = {};
  seriesKeys.forEach(sk => {
    result[sk] = { x: [], y: [], isDate: isDateCol };
    xOrder.forEach(xv => {
      const vals = (map[xv] && map[xv][sk]) ? map[xv][sk] : [];
      const yAgg = vals.length > 0 ? aggregate(vals, effectiveAgg) : null;
      result[sk].x.push(xv);
      result[sk].y.push(yAgg);
    });
  });

  return { result, xOrder, seriesKeys, isDateCol };
}

// Sort helper (manual sort from config, applied after grouping).
// When isDateSorted is true the data already has chronological order from
// buildGroupedData; we only re-sort if the user explicitly asked for it,
// and we always prefer date comparison over locale-string comparison.
function sortXY(x, y, sort, isDateSorted) {
  // No sort requested AND chronological order already applied — leave untouched
  if (!sort && isDateSorted) return { x, y };
  if (!sort) return { x, y };

  const pairs = x.map((xv, i) => [xv, y[i]]);

  const dateCmp = (a, b, asc) => {
    const da = toDate(a), db = toDate(b);
    if (da && db) return asc ? da - db : db - da;
    return asc
      ? String(a).localeCompare(String(b), undefined, { numeric: true })
      : String(b).localeCompare(String(a), undefined, { numeric: true });
  };

  if (sort === 'x_asc')  pairs.sort((a, b) => dateCmp(a[0], b[0], true));
  if (sort === 'x_desc') pairs.sort((a, b) => dateCmp(a[0], b[0], false));
  if (sort === 'y_asc')  pairs.sort((a, b) => (a[1] ?? -Infinity) - (b[1] ?? -Infinity));
  if (sort === 'y_desc') pairs.sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity));

  return { x: pairs.map(p => p[0]), y: pairs.map(p => p[1]) };
}

// When date_group is active the X values are already human-readable label
// strings (e.g. "Jun 2025", "Q2 2025", "2025"), not ISO date strings, so
// Plotly must NOT treat the axis as type:'date' — it should just be category.
function _dateGroupUsesLabels(dateGroup) {
  return dateGroup && dateGroup !== '';
}

// Choose an appropriate Plotly tickformat based on the actual date span
// present in the data and the date_trunc/date_group setting.
function _pickTickformat(xValues, dateTrunc) {
  // If the server has already truncated/formatted to a known granularity, use that.
  if (dateTrunc === 'year')    return '%Y';
  if (dateTrunc === 'quarter') return 'Q%-q %Y';
  if (dateTrunc === 'month')   return '%b %Y';
  if (dateTrunc === 'week' || dateTrunc === 'day') return '%d %b %Y';

  // No server-side trunc — infer from the data span.
  const dates = xValues.map(toDate).filter(Boolean);
  if (dates.length < 2) return '%d %b %Y';

  const minD = new Date(Math.min(...dates));
  const maxD = new Date(Math.max(...dates));
  const spanDays = (maxD - minD) / 86400000;

  if (spanDays <= 2)    return '%H:%M';
  if (spanDays <= 90)   return '%d %b';
  if (spanDays <= 730)  return '%b %Y';
  return '%Y';
}

function renderPlotly(container, chartType, data, config) {
  const colors = PALETTES[config.palette || 'default'];
  const showLegend = config.show_legend !== false;
  const showLabels = config.show_labels === true;
  const showMarkers = config.show_markers !== false;
  const xCol = config.x_column;
  const yCols = config.y_columns || (config.y_column ? [config.y_column] : []);
  const seriesCol = config.series_column || '';
  const agg = config.aggregation || 'none';
  const dateGroup = config.date_group || '';
  const sort = config.sort || '';
  const barMode = config.bar_mode || 'group';
  const lineShape = config.line_style || 'linear';

  // Secondary axis config (line/area only)
  const y2Col  = (chartType === 'line' || chartType === 'area') ? (config.y2_column || '') : '';
  const y2Agg  = config.y2_aggregation || 'sum';
  const y2Title = config.y2_title || '';
  const y1Title = config.y1_title || '';
  const hasY2  = !!y2Col;

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { family: 'DM Sans, sans-serif', color: '#94a3b8', size: 11 },
    margin: { t: 10, r: hasY2 ? 60 : 16, b: 48, l: 52 },
    showlegend: showLegend,
    legend: { font: { size: 11 }, bgcolor: 'transparent', orientation: 'h', y: -0.18 },
    xaxis: { gridcolor: '#2a2f45', linecolor: '#2a2f45', tickfont: { size: 11 }, automargin: true },
    yaxis: {
      gridcolor: '#2a2f45', linecolor: '#2a2f45', tickfont: { size: 11 },
      title: y1Title ? { text: y1Title, font: { size: 11, color: '#94a3b8' } } : undefined,
    },
    autosize: true,
    barmode: barMode === 'stack' ? 'stack' : barMode === 'relative' ? 'relative' : 'group',
  };

  if (hasY2) {
    layout.yaxis2 = {
      overlaying: 'y',
      side: 'right',
      gridcolor: 'transparent',
      linecolor: '#2a2f45',
      tickfont: { size: 11, color: colors[colors.length - 1] },
      title: y2Title ? { text: y2Title, font: { size: 11, color: colors[colors.length - 1] } } : undefined,
      showgrid: false,
    };
  }

  const plotConfig = { responsive: true, displayModeBar: false };
  let traces = [];

  // ── Pie / Donut ───────────────────────────────────────────────────────────
  if (chartType === 'pie' || chartType === 'donut') {
    const yCol = yCols[0] || '';
    let labels, values;
    if (agg !== 'none' && xCol && yCol) {
      const { result, seriesKeys } = buildGroupedData(data, xCol, yCol, '', agg, dateGroup);
      const sk = seriesKeys[0] || yCol;
      labels = result[sk]?.x || [];
      values = result[sk]?.y || [];
    } else {
      labels = getColValues(data, data.columns, xCol);
      values = getColValues(data, data.columns, yCol).map(v => parseFloat(v));
    }
    traces = [{ type: 'pie', labels, values, hole: chartType === 'donut' ? 0.45 : 0, marker: { colors }, textinfo: showLabels ? 'label+percent' : 'percent' }];
    layout.margin = { t: 20, r: 20, b: 20, l: 20 };
    Plotly.newPlot(container, traces, layout, plotConfig);
    return;
  }

  // ── Series-based charts (bar, line, area, scatter) ────────────────────────
  const isLine = chartType === 'line' || chartType === 'area';
  const isBar  = chartType === 'bar';
  const isScatter = chartType === 'scatter';

  let isDateCol = false;

  if (seriesCol && yCols.length > 0) {
    const { result, seriesKeys, isDateCol: idc } = buildGroupedData(data, xCol, yCols[0], seriesCol, agg, dateGroup);
    isDateCol = idc;
    seriesKeys.forEach((sk, i) => {
      let { x, y } = sortXY(result[sk].x, result[sk].y, sort, isDateCol);
      traces.push(makeTrace(chartType, x, y, sk, colors[i % colors.length], isLine, isBar, isScatter, showLabels, showMarkers, lineShape, i, 'y'));
    });
  } else {
    yCols.forEach((yCol, i) => {
      const { result, seriesKeys, isDateCol: idc } = buildGroupedData(data, xCol, yCol, '', agg, dateGroup);
      if (i === 0) isDateCol = idc;
      const sk = seriesKeys[0] || yCol;
      let { x, y } = sortXY(result[sk]?.x || [], result[sk]?.y || [], sort, idc);
      traces.push(makeTrace(chartType, x, y, yCol, colors[i % colors.length], isLine, isBar, isScatter, showLabels, showMarkers, lineShape, i, 'y'));
    });
  }

  // ── Secondary Y axis trace ────────────────────────────────────────────────
  if (hasY2) {
    const y2Color = colors[traces.length % colors.length];
    const { result: r2, seriesKeys: sk2, isDateCol: idc2 } = buildGroupedData(data, xCol, y2Col, '', y2Agg, dateGroup);
    if (!isDateCol && idc2) isDateCol = idc2;
    const sk = sk2[0] || y2Col;
    let { x: x2, y: y2 } = sortXY(r2[sk]?.x || [], r2[sk]?.y || [], sort, idc2);
    const y2Label = y2Title || `${y2Col} (${y2Agg})`;
    const t2 = makeTrace(chartType, x2, y2, y2Label, y2Color, isLine, isBar, isScatter, showLabels, showMarkers, lineShape, traces.length, 'y2');
    // Make secondary axis trace visually distinct: dashed line
    if (t2.line) t2.line.dash = 'dot';
    traces.push(t2);
  }

  // If X is dates, configure the axis appropriately.
  if (isDateCol) {
    if (_dateGroupUsesLabels(dateGroup)) {
      layout.xaxis.type = 'category';
    } else {
      layout.xaxis.type = 'date';
      layout.xaxis.tickformat = _pickTickformat(
        traces.flatMap(t => t.x).filter(Boolean),
        config.date_trunc
      );
    }
  }

  Plotly.newPlot(container, traces, layout, plotConfig);
}

function makeTrace(chartType, x, y, name, color, isLine, isBar, isScatter, showLabels, showMarkers, lineShape, idx, yaxis) {
  const trace = { x, y, name };
  if (yaxis) trace.yaxis = yaxis;  // 'y' (primary) or 'y2' (secondary)
  if (isBar) {
    trace.type = 'bar';
    trace.marker = { color };
    if (showLabels) { trace.text = y.map(v => v !== null ? formatNum(v) : ''); trace.textposition = 'outside'; }
  } else if (isScatter) {
    trace.type = 'scatter';
    trace.mode = 'markers';
    trace.marker = { color, size: 8 };
  } else if (chartType === 'area') {
    trace.type = 'scatter';
    trace.mode = showMarkers ? 'lines+markers' : 'lines';
    trace.fill = idx === 0 ? 'tozeroy' : 'tonexty';
    trace.line = { color, width: 2, shape: lineShape };
    trace.fillcolor = hexToRgba(color, 0.15);
    trace.marker = { color, size: 5 };
  } else {
    // line
    trace.type = 'scatter';
    trace.mode = showMarkers ? 'lines+markers' : 'lines';
    trace.line = { color, width: 2, shape: lineShape };
    trace.marker = { color, size: 6 };
    if (showLabels) { trace.text = y.map(v => v !== null ? formatNum(v) : ''); trace.textposition = 'top center'; }
  }
  return trace;
}

// Legacy single-col helper (still used by preview if old config)
function aggregateByGroup(data, columns, xCol, yCol, aggMethod) {
  const { result, seriesKeys } = buildGroupedData({ columns, data: data.data || data }, xCol, yCol, '', aggMethod);
  const sk = seriesKeys[0] || yCol;
  return { x: result[sk]?.x || [], y: result[sk]?.y || [] };
}


// ── KPI Formula Engine ─────────────────────────────────────────────────────
// Syntax: SUM(col) / COUNT(col) * 100  etc.
// Supported: SUM AVG COUNT DISTINCT_COUNT MIN MAX MEDIAN + - * / ( )
// Column names with spaces: SUM("My Col") or SUM('My Col')
// ──────────────────────────────────────────────────────────────────────────

const KPI_AGG_FUNCS = ['SUM','AVG','COUNT','DISTINCT_COUNT','MIN','MAX','MEDIAN'];

function evaluateKpiFormula(formula, data) {
  if (!formula || !formula.trim()) throw new Error('Formula is empty');
  const cols = data.columns;
  let expr = formula.trim();

  // Replace FUNC("col") and FUNC(col) — greedy match handles multi-word col names
  // Process longest function names first to avoid DISTINCT matching before DISTINCT_COUNT
  const sorted = [...KPI_AGG_FUNCS].sort((a, b) => b.length - a.length);
  for (const fn of sorted) {
    // Matches: FUNC("col name") or FUNC('col name') or FUNC(col_name)
    const re = new RegExp(fn + '\\s*\\(\\s*(?:"([^"]+)"|\'([^\']+)\'|([^)]+?))\\s*\\)', 'gi');
    expr = expr.replace(re, (match, q1, q2, bare) => {
      const col = (q1 || q2 || bare || '').trim();
      const idx = cols.indexOf(col);
      if (idx < 0) throw new Error('Column not found: "' + col + '"');
      const raw = data.data.map(r => r[idx]);
      const nums = raw.map(v => parseFloat(v)).filter(v => !isNaN(v));
      switch (fn) {
        case 'SUM':            return nums.reduce((a, b) => a + b, 0);
        case 'AVG':            return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        case 'COUNT':          return raw.filter(v => v !== null && v !== undefined && v !== '').length;
        case 'DISTINCT_COUNT': return new Set(raw.filter(v => v !== null && v !== undefined && v !== '').map(String)).size;
        case 'MIN':            return nums.length ? Math.min(...nums) : 0;
        case 'MAX':            return nums.length ? Math.max(...nums) : 0;
        case 'MEDIAN': {
          if (!nums.length) return 0;
          const s = [...nums].sort((a, b) => a - b);
          const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        }
        default: throw new Error('Unknown function: ' + fn);
      }
    });
  }

  // After substitution only numbers + math ops should remain
  if (/[a-zA-Z_$]/.test(expr)) {
    const bad = (expr.match(/[a-zA-Z_$][\w$]*/) || ['?'])[0];
    throw new Error('Unrecognised token "' + bad + '" — wrap column names in SUM(), AVG(), etc.');
  }

  // Evaluate the numeric expression safely
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + expr + ')')();
    if (isNaN(result))       throw new Error('Result is NaN — check for empty columns or division by zero');
    if (!isFinite(result))   throw new Error('Result is Infinity — division by zero');
    return result;
  } catch (e) {
    if (e.message.startsWith('Result')) throw e;
    throw new Error('Math error: ' + e.message);
  }
}

function validateKpiFormula(formulaId, hintId) {
  const formula = (document.getElementById(formulaId) || {}).value || '';
  const hintEl  = document.getElementById(hintId);
  if (!hintEl) return;
  if (!formula.trim()) { hintEl.textContent = ''; return; }
  // Paren balance
  let depth = 0;
  for (const ch of formula) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) break; }
  }
  if (depth !== 0) {
    hintEl.style.color = 'var(--danger)';
    hintEl.textContent = depth > 0 ? '\u26a0 Unclosed parenthesis' : '\u26a0 Extra closing parenthesis';
    return;
  }
  // Unknown function names
  const refs = formula.match(/\b([A-Z_]+)\s*\(/gi) || [];
  for (const ref of refs) {
    const fn = ref.replace(/\s*\(/, '').toUpperCase();
    if (!KPI_AGG_FUNCS.includes(fn)) {
      hintEl.style.color = 'var(--danger)';
      hintEl.textContent = '\u26a0 Unknown function "' + fn + '"';
      return;
    }
  }
  hintEl.style.color = 'var(--success)';
  hintEl.textContent = '\u2713 Formula looks valid';
}

// Toggle Simple / Formula mode in a KPI config block.
// prefix = 'kpi' (wizard panel) or 'editKpi' (edit panel)
function setKpiMode(mode, prefix) {
  const isFormula = mode === 'formula';
  const simpleEl  = document.getElementById(prefix + 'SimpleConfig');
  const formulaEl = document.getElementById(prefix + 'FormulaConfig');
  const simpleBtn = document.getElementById(prefix + 'ModeSimple');
  const formulaBtn = document.getElementById(prefix + 'ModeFormula');
  if (simpleEl)  simpleEl.style.display  = isFormula ? 'none'  : 'block';
  if (formulaEl) formulaEl.style.display = isFormula ? 'block' : 'none';
  if (simpleBtn)  simpleBtn.classList.toggle('active',  !isFormula);
  if (formulaBtn) formulaBtn.classList.toggle('active',  isFormula);
}

function renderKPI(body, data, config) {
  const prefix   = config.kpi_prefix   || '';
  const suffix   = config.kpi_suffix   || '';
  const decimals = config.kpi_decimals || 'auto';

  let result, label;

  if (config.kpi_formula && config.kpi_formula.trim()) {
    try {
      result = evaluateKpiFormula(config.kpi_formula, data);
      const f = config.kpi_formula.trim();
      label  = f.length > 44 ? f.slice(0, 44) + '…' : f;
    } catch (e) {
      body.innerHTML = `<div class="kpi-widget"><div style="color:var(--danger);font-size:13px;text-align:center;padding:16px"><i class="fa fa-exclamation-triangle"></i><br>${escapeHtml(e.message)}</div></div>`;
      return;
    }
  } else {
    const col = config.kpi_column;
    const agg = config.kpi_agg || 'sum';
    const values = getColValues(data, data.columns, col);
    result = aggregate(values, agg);
    label  = col + ' · ' + agg.toUpperCase();
  }

  const formatted = _formatKpiValue(result, decimals);
  body.innerHTML = `
    <div class="kpi-widget">
      <div class="kpi-value">${escapeHtml(prefix)}${formatted}${escapeHtml(suffix)}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
    </div>`;
}

function _formatKpiValue(n, decimals) {
  if (typeof n !== 'number' || isNaN(n)) return String(n);
  if (decimals === 'auto') return formatNum(n);
  const d = parseInt(decimals);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (Math.abs(n) >= 1e3 && d === 0) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(d);
}

function renderTable(body, data, config) {
  const columns = data.columns;
  let rows = data.data;

  body.innerHTML = `
    <div class="table-widget">
      <table class="data-table">
        <thead><tr>${columns.map((c,i) => `<th onclick="sortTable(this,${i})">${escapeHtml(c)} <i class="fa fa-sort" style="font-size:10px;opacity:0.4"></i></th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0,200).map(r => `<tr>${r.map(cell => `<td>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function sortTable(th, colIdx) {
  const table = th.closest('table');
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const asc = th.dataset.sort !== 'asc';
  th.dataset.sort = asc ? 'asc' : 'desc';
  rows.sort((a,b) => {
    const va = a.cells[colIdx].textContent;
    const vb = b.cells[colIdx].textContent;
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!isNaN(na) && !isNaN(nb)) return asc ? na-nb : nb-na;
    return asc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  rows.forEach(r => tbody.appendChild(r));
}

// ── Edit Widget ────────────────────────────────────────────────────────────
function openEditWidget(uid) {
  try {
    editingWidgetUid = uid;
    const w = widgets.find(x => x.uid === uid);
    if (!w) { console.error('Widget not found:', uid); return; }

    const config = w.config || {};
    editFilters = [...(config.filters || [])].map((f,i) => ({...f, id: f.id || Date.now()+i}));
    editCustomFilters = [...(config.custom_filters || [])].map((f,i) => ({...f, id: f.id || Date.now()+i}));
    editPalette = config.palette || 'default';

    // Populate fields
    document.getElementById('editWidgetTitle').value = w.title || '';
    document.getElementById('editChartType').value = w.chart_type || 'bar';
    const typeLabel = document.getElementById('editWidgetTypeLabel');
    if (typeLabel) typeLabel.textContent = (w.chart_type || 'bar').toUpperCase();
    updateEditStyleControls(w.chart_type || 'bar');

    // Datasets
    const sel = document.getElementById('editDatasetSelect');
    sel.innerHTML = '<option value="">— None —</option>' + datasets.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
    sel.value = w.dataset_id || '';

    if (w.dataset_id) populateEditColumns(w.dataset_id, config);
    else document.getElementById('editAxisConfig').style.display = 'none';

    // Style
    selectEditPalette(editPalette);
    document.getElementById('editShowLegend').checked = config.show_legend !== false;
    document.getElementById('editShowLabels').checked = !!config.show_labels;
    const mkrEl = document.getElementById('editShowMarkers');
    if (mkrEl) mkrEl.checked = config.show_markers !== false;

    // Filters
    const ds = datasets.find(d => d.id === w.dataset_id);
    const useDash = config.use_dashboard_filters !== false;
    const udf = document.getElementById('editUseDashFilters');
    if (udf) udf.checked = useDash;
    _updateEditFilterSections(useDash);
    if (ds) {
      renderFilters('editFiltersList', editFilters, ds.columns);
      renderFilters('editCustomFiltersList', editCustomFilters, ds.columns);
    } else {
      document.getElementById('editFiltersList').innerHTML = '';
      document.getElementById('editCustomFiltersList').innerHTML = '';
    }

    showEditTab('data');
    openPanel('editPanel');
  } catch(e) {
    console.error('openEditWidget error:', e);
    alert('Could not open editor: ' + e.message);
  }
}

function populateEditColumns(dsId, config) {
  const ds = datasets.find(d => d.id === parseInt(dsId));
  if (!ds) { document.getElementById('editAxisConfig').style.display = 'none'; return; }
  document.getElementById('editAxisConfig').style.display = 'block';
  const cols = ds.columns;
  const numericCols = cols.filter(c => c.type === 'numeric');

  const xSel = document.getElementById('editXSelect');
  xSel.innerHTML = cols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  if (config.x_column) xSel.value = config.x_column;

  // Y columns (multi-series)
  const yWrap = document.getElementById('editYColsWrap');
  yWrap.innerHTML = '';
  const yCols = config.y_columns || (config.y_column ? [config.y_column] : []);
  const defaultY = (numericCols[0] || cols[1] || cols[0])?.name || '';
  if (yCols.length === 0) yCols.push(defaultY);
  yCols.forEach((yc, i) => yWrap.appendChild(makeYColRow(cols, yc, i > 0)));

  // Series pivot
  populateSeriesSelect(ds, 'editSeriesSelect', xSel.value);
  if (config.series_column) document.getElementById('editSeriesSelect').value = config.series_column;

  // Aggregation & sort
  if (config.aggregation) document.getElementById('editAggSelect').value = config.aggregation;
  const dgEl = document.getElementById('editDateGroupSelect');
  if (dgEl) dgEl.value = config.date_group || '';
  const _xColForVis = config.x_column || xSel.value;
  const _dsIdForVis = parseInt(dsId);
  // Check immediately, then again after prefetch in case cache was empty
  _updateDateGroupVisibility(_xColForVis, _dsIdForVis, 'editDateGroupSelect', 'editDateGroupRow');
  _prefetchColumnValues(ds).then(() =>
    _updateDateGroupVisibility(_xColForVis, _dsIdForVis, 'editDateGroupSelect', 'editDateGroupRow')
  );
  const sortEl = document.getElementById('editSortSelect');
  if (sortEl && config.sort) sortEl.value = config.sort;

  // Style
  const chartType = document.getElementById('editChartType').value;
  updateEditStyleControls(chartType);
  if (config.bar_mode) { const el = document.getElementById('editBarModeSelect'); if(el) el.value = config.bar_mode; }
  if (config.line_style) { const el = document.getElementById('editLineStyleSelect'); if(el) el.value = config.line_style; }
  const mkrEl = document.getElementById('editShowMarkers');
  if (mkrEl) mkrEl.checked = config.show_markers !== false;

  // KPI - all columns (distinct_count can count any column)
  const kpiSel = document.getElementById('editKpiColumn');
  kpiSel.innerHTML = cols.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  if (config.kpi_column) kpiSel.value = config.kpi_column;
  if (config.kpi_agg) document.getElementById('editKpiAgg').value = config.kpi_agg;
  document.getElementById('editKpiPrefix').value = config.kpi_prefix || '';
  document.getElementById('editKpiSuffix').value = config.kpi_suffix || '';
  // Restore formula mode
  const _savedFormula = config.kpi_formula || '';
  const formulaTextEl = document.getElementById('editKpiFormula');
  if (formulaTextEl) formulaTextEl.value = _savedFormula;
  const kpiDecEl = document.getElementById('editKpiDecimals');
  if (kpiDecEl) kpiDecEl.value = config.kpi_decimals || 'auto';
  setKpiMode(_savedFormula.trim() ? 'formula' : 'simple', 'editKpi');

  // Secondary axis — populate col select and restore saved values
  const y2Sel = document.getElementById('editY2ColSelect');
  if (y2Sel) {
    y2Sel.innerHTML = '<option value="">— None (no secondary axis) —</option>' +
      cols.map(c => `<option value="${c.name}" ${c.name === (config.y2_column || '') ? 'selected' : ''}>${c.name}</option>`).join('');
  }
  const y2AggSel = document.getElementById('editY2AggSelect');
  if (y2AggSel && config.y2_aggregation) y2AggSel.value = config.y2_aggregation;
  const y1TitleEl = document.getElementById('editY1TitleInput');
  if (y1TitleEl) y1TitleEl.value = config.y1_title || '';
  const y2TitleEl = document.getElementById('editY2TitleInput');
  if (y2TitleEl) y2TitleEl.value = config.y2_title || '';

  updateAxisLabels(chartType, 'editXLabel', 'editYLabel', 'editKpiConfig', 'editAxisConfig', 'editXGroup', 'editYGroup');
}

function onEditDatasetChange() {
  const dsId = document.getElementById('editDatasetSelect').value;
  const ds = datasets.find(d => d.id === parseInt(dsId));
  if (ds) _prefetchColumnValues(ds);

  // Snapshot every current setting from the form so populateEditColumns
  // can preserve them — it only falls back when a column name doesn't exist
  // in the new dataset.
  const currentConfig = _snapshotEditConfig();

  populateEditColumns(dsId, currentConfig);
  // Re-render filters against the new dataset's columns but keep existing filters
  if (ds) renderFilters('editFiltersList', editFilters, ds.columns);
}

// Capture the current live state of the edit panel into a config object.
// Used to preserve settings when switching datasets.
function _snapshotEditConfig() {
  const yCols = getEditYCols();
  return {
    x_column:      val('editXSelect'),
    y_columns:     yCols,
    y_column:      yCols[0] || '',
    series_column: val('editSeriesSelect'),
    aggregation:   val('editAggSelect', 'none'),
    date_group:    val('editDateGroupSelect', ''),
    sort:          val('editSortSelect'),
    bar_mode:      val('editBarModeSelect', 'group'),
    line_style:    val('editLineStyleSelect', 'linear'),
    kpi_column:    val('editKpiColumn'),
    kpi_agg:       val('editKpiAgg', 'sum'),
    kpi_formula:   document.getElementById('editKpiModeFormula')?.classList.contains('active') ? val('editKpiFormula') : '',
    kpi_decimals:  val('editKpiDecimals', 'auto'),
    kpi_prefix:    val('editKpiPrefix'),
    kpi_suffix:    val('editKpiSuffix'),
    y2_column:     val('editY2ColSelect', ''),
    y2_aggregation: val('editY2AggSelect', 'sum'),
    y1_title:      val('editY1TitleInput', ''),
    y2_title:      val('editY2TitleInput', ''),
    use_dashboard_filters: document.getElementById('editUseDashFilters')?.checked !== false,
  };
}

function updateEditStyleControls(chartType) {
  const isBar = chartType === 'bar';
  const isLine = chartType === 'line' || chartType === 'area';
  const el = (id) => document.getElementById(id);
  if (el('editBarModeGroup'))     el('editBarModeGroup').style.display = isBar ? 'block' : 'none';
  if (el('editLineStyleGroup'))   el('editLineStyleGroup').style.display = isLine ? 'block' : 'none';
  if (el('editLineMarkersGroup')) el('editLineMarkersGroup').style.display = isLine ? 'block' : 'none';
  if (el('editY2Section'))        el('editY2Section').style.display = isLine ? 'block' : 'none';
}

// Called when chart type dropdown changes inside the edit panel Style tab
function updateEditPreview() {
  const chartType = val('editChartType');
  updateEditStyleControls(chartType);
  updateAxisLabels(chartType, 'editXLabel', 'editYLabel', 'editKpiConfig', 'editAxisConfig', 'editXGroup', 'editYGroup');
}

function updateWizardStyleControls(chartType) {
  const isBar = chartType === 'bar';
  const isLine = chartType === 'line' || chartType === 'area';
  const el = (id) => document.getElementById(id);
  if (el('barModeGroup'))     el('barModeGroup').style.display = isBar ? 'block' : 'none';
  if (el('lineStyleGroup'))   el('lineStyleGroup').style.display = isLine ? 'block' : 'none';
  if (el('lineMarkersGroup')) el('lineMarkersGroup').style.display = isLine ? 'block' : 'none';
  if (el('wizardY2Section'))  el('wizardY2Section').style.display = isLine ? 'block' : 'none';
}


function showEditTab(tab, clickedEl) {
  document.querySelectorAll('.edit-tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.edit-tab').forEach(el => el.classList.remove('active'));
  document.getElementById(`editTab-${tab}`).style.display = 'block';
  if (clickedEl) {
    clickedEl.classList.add('active');
  } else {
    // Called programmatically — activate the matching tab button
    const btn = document.querySelector(`.edit-tab[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    else document.querySelector('.edit-tab')?.classList.add('active');
  }
}

async function applyWidgetEdit() {
  const btn = document.querySelector('#editPanel .btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Saving...'; }

  try {
    const w = widgets.find(x => x.uid === editingWidgetUid);
    if (!w) return;

    const dsId = val('editDatasetSelect');
    const chartType = val('editChartType');
    const yCols = getEditYCols();

    const config = {
      x_column:    val('editXSelect'),
      y_columns:   yCols,
      y_column:    yCols[0] || '',
      series_column: val('editSeriesSelect'),
      aggregation: val('editAggSelect', 'none'),
      date_group:  val('editDateGroupSelect', ''),
      sort:        val('editSortSelect'),
      bar_mode:    val('editBarModeSelect', 'group'),
      line_style:  val('editLineStyleSelect', 'linear'),
      show_markers: checked('editShowMarkers', true),
      kpi_column:  val('editKpiColumn'),
      kpi_agg:     val('editKpiAgg', 'sum'),
      kpi_formula: document.getElementById('editKpiModeFormula')?.classList.contains('active') ? val('editKpiFormula') : '',
      kpi_decimals: val('editKpiDecimals', 'auto'),
      kpi_prefix:  val('editKpiPrefix'),
      kpi_suffix:  val('editKpiSuffix'),
      palette:     editPalette,
      show_legend: checked('editShowLegend', true),
      show_labels: checked('editShowLabels', false),
      y2_column:    val('editY2ColSelect', ''),
      y2_aggregation: val('editY2AggSelect', 'sum'),
      y1_title:     val('editY1TitleInput', ''),
      y2_title:     val('editY2TitleInput', ''),
      use_dashboard_filters: document.getElementById('editUseDashFilters')?.checked !== false,
      filters:     normalizeFilters(editFilters),       // additional on top of dashboard
      custom_filters: normalizeFilters(editCustomFilters), // used when use_dashboard_filters=false
    };

    w.title = val('editWidgetTitle') || w.title;
    w.chart_type = chartType;
    w.dataset_id = dsId ? parseInt(dsId) : null;
    w.config = config;

    const titleEl = document.querySelector(`#wcard-${w.uid} .widget-title`);
    if (titleEl) titleEl.textContent = w.title;

    await fetch(`/api/widget/${w.uid}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title: w.title, chart_type: chartType, dataset_id: w.dataset_id, config })
    });

    await renderWidget(w);
    closeEditPanel();
  } catch(e) {
    console.error('applyWidgetEdit error:', e);
    alert('Error saving changes: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-check"></i> Apply Changes'; }
  }
}

// ── Convert Widget ─────────────────────────────────────────────────────────
const CHART_TYPES = [
  { type: 'bar',     icon: 'fa-chart-bar',        label: 'Bar' },
  { type: 'line',    icon: 'fa-chart-line',        label: 'Line' },
  { type: 'area',    icon: 'fa-chart-area',        label: 'Area' },
  { type: 'scatter', icon: 'fa-braille',           label: 'Scatter' },
  { type: 'pie',     icon: 'fa-chart-pie',         label: 'Pie' },
  { type: 'donut',   icon: 'fa-circle-notch',      label: 'Donut' },
  { type: 'table',   icon: 'fa-table',             label: 'Table' },
  { type: 'kpi',     icon: 'fa-tachometer-alt',    label: 'KPI' },
];

function openConvertWidget(uid) {
  // Remove any existing popover
  closeConvertPopover();

  const w = widgets.find(x => x.uid === uid);
  if (!w) return;

  const btn = document.querySelector(`#wcard-${uid} .icon-btn[title="Convert to chart"]`);
  if (!btn) return;

  const popover = document.createElement('div');
  popover.id = 'convertPopover';
  popover.className = 'convert-popover';
  popover.innerHTML = `
    <div class="convert-popover-title">Convert to…</div>
    <div class="convert-grid">
      ${CHART_TYPES.map(ct => `
        <button class="convert-option ${w.chart_type === ct.type ? 'current' : ''}"
          onclick="convertWidget('${uid}','${ct.type}')"
          title="${ct.label}">
          <i class="fa ${ct.icon}"></i>
          <span>${ct.label}</span>
        </button>`).join('')}
    </div>`;

  // Position below the button
  document.body.appendChild(popover);
  const rect = btn.getBoundingClientRect();
  const pop = popover.getBoundingClientRect();
  let left = rect.right - pop.width;
  if (left < 8) left = 8;
  popover.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  popover.style.left = (left + window.scrollX) + 'px';

  // Close on outside click
  setTimeout(() => document.addEventListener('click', closeConvertOnOutside), 0);
}

function closeConvertOnOutside(e) {
  const pop = document.getElementById('convertPopover');
  if (pop && !pop.contains(e.target)) closeConvertPopover();
}

function closeConvertPopover() {
  const pop = document.getElementById('convertPopover');
  if (pop) pop.remove();
  document.removeEventListener('click', closeConvertOnOutside);
}

async function convertWidget(uid, newType) {
  closeConvertPopover();
  const w = widgets.find(x => x.uid === uid);
  if (!w || w.chart_type === newType) return;

  // Build a smart config based on the new type
  const config = { ...w.config };

  // If converting from table/kpi to a chart, ensure y_columns has something
  if (!['table','kpi'].includes(newType) && (!config.y_columns || !config.y_columns.length)) {
    if (config.y_column) config.y_columns = [config.y_column];
  }
  // If converting to KPI, default kpi_column from y_column
  if (newType === 'kpi' && !config.kpi_column) {
    config.kpi_column = config.y_columns?.[0] || config.y_column || '';
    config.kpi_agg = config.aggregation || 'sum';
  }
  // Add default aggregation if none set
  if (!['table'].includes(newType) && (!config.aggregation || config.aggregation === 'none')) {
    config.aggregation = 'sum';
  }

  w.chart_type = newType;
  w.config = config;

  // Persist
  await fetch(`/api/widget/${w.uid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: w.title, chart_type: newType, dataset_id: w.dataset_id, config })
  });

  // Re-render
  await renderWidget(w);
}

// ── Delete Widget ──────────────────────────────────────────────────────────
async function deleteWidget(uid) {
  if (!confirm('Remove this widget?')) return;

  await fetch(`/api/widget/${uid}`, { method: 'DELETE' });
  widgets = widgets.filter(w => w.uid !== uid);

  const el = document.querySelector(`[gs-id="${uid}"]`);
  if (el) grid.removeWidget(el);
  checkCanvasEmpty();
}

// ── Save Layouts ───────────────────────────────────────────────────────────
async function saveAllLayouts() {
  const items = grid.getGridItems().map(el => ({
    uid: el.getAttribute('gs-id'),
    layout: {
      x: parseInt(el.getAttribute('gs-x')),
      y: parseInt(el.getAttribute('gs-y')),
      w: parseInt(el.getAttribute('gs-w')),
      h: parseInt(el.getAttribute('gs-h')),
    }
  })).filter(i => i.uid);

  await fetch(`/api/dashboard/${DASHBOARD_UID}/widgets/layout`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(items)
  });
}

// ── Dataset selects ────────────────────────────────────────────────────────
function populateDatasetSelects() {
  const sel = document.getElementById('datasetSelect');
  if (sel) {
    sel.innerHTML = '<option value="">— Select dataset —</option>' +
      datasets.map(d => `<option value="${d.id}">${escapeHtml(d.name)} (${d.row_count} rows)</option>`).join('');
  }

  // Also populate the dashboard filter dataset picker
  const dashSel = document.getElementById('dashFilterDsSelect');
  if (dashSel) {
    const prev = dashSel.value;
    dashSel.innerHTML = datasets.map(d =>
      `<option value="${d.id}">${escapeHtml(d.name)}</option>`
    ).join('') || '<option value="">— No datasets —</option>';
    // Restore previous selection if still valid
    if (prev && [...dashSel.options].some(o => o.value === prev)) dashSel.value = prev;
  }

  updateTransformBtn();
}

// ── Upload panel ───────────────────────────────────────────────────────────
function showUploadPanel() {
  openPanel('uploadPanel');
}

function initUploadZone() {
  const zone = document.getElementById('uploadZone2');
  const input = document.getElementById('uploadFileInput2');
  if (!zone || !input) return;

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); uploadFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => uploadFile(input.files[0]));
}

async function uploadFile(file) {
  if (!file) return;
  const progress = document.getElementById('uploadProgress');
  const fill = document.getElementById('progressFill');
  const status = document.getElementById('uploadStatus');

  progress.style.display = 'block';
  fill.style.width = '20%';
  status.textContent = `Uploading ${file.name}...`;

  const fd = new FormData();
  fd.append('file', file);

  try {
    fill.style.width = '60%';
    const res = await fetch(`/api/dashboard/${DASHBOARD_UID}/upload`, { method: 'POST', body: fd });
    fill.style.width = '90%';
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fill.style.width = '100%';
    status.textContent = '✓ Uploaded successfully!';
    status.style.color = 'var(--success)';

    datasets.push({ id: data.id, name: data.name, columns: data.columns, row_count: data.row_count });
    populateDatasetSelects();

    setTimeout(() => {
      progress.style.display = 'none';
      fill.style.width = '0%';
      status.style.color = '';
      closeUploadPanel();
    }, 1200);
  } catch (e) {
    status.textContent = '✗ Error: ' + e.message;
    status.style.color = 'var(--danger)';
    fill.style.width = '0%';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatNum(n) {
  if (typeof n !== 'number') n = parseFloat(n);
  if (isNaN(n)) return n;
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}


// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD FILTERS
// ═══════════════════════════════════════════════════════════════════════════

function openDashboardFilters() {
  // Deep-copy current dashboardFilters into the working copy
  dashFilterEditing = dashboardFilters.map(f => ({ ...f }));
  _renderDashFilterPanel();
  openPanel('dashFilterPanel');
}

function _renderDashFilterPanel() {
  const container = document.getElementById('dashFilterRows');
  if (!container) return;

  if (!dashFilterEditing.length) {
    container.innerHTML = `
      <div class="dash-filter-empty">
        <i class="fa fa-filter" style="font-size:28px;color:var(--border2);margin-bottom:8px;"></i>
        <p>No dashboard filters yet.</p>
        <p style="font-size:12px;color:var(--text3);">Filters here apply to every widget that uses the matching dataset.</p>
      </div>`;
    _updateDashFilterBadge();
    return;
  }

  // Group rows by dataset for clarity, preserving absolute indices
  const byDs = {};
  const dsOrder = [];
  dashFilterEditing.forEach((f, idx) => {
    const key = f.dataset_id;
    if (!byDs[key]) { byDs[key] = []; dsOrder.push(key); }
    byDs[key].push({ f, idx });
  });
  // Deduplicate dsOrder (same dataset_id could appear from concurrent pushes)
  const seenDs = new Set();
  const uniqueDsOrder = dsOrder.filter(id => { if (seenDs.has(id)) return false; seenDs.add(id); return true; });

  container.innerHTML = uniqueDsOrder.map(dsId => {
    const ds = datasets.find(d => d.id === dsId);
    const label = ds ? escapeHtml(ds.name) : `Dataset ${dsId}`;
    const entries = byDs[dsId];
    const filterRows = entries.map(({ f, idx }) =>
      _dashFilterRowHtml(f, idx, ds?.columns || [])
    ).join('');
    return `
      <div class="dash-filter-group">
        <div class="dash-filter-group-label">
          <i class="fa fa-database" style="color:var(--accent);margin-right:6px"></i>${label}
        </div>
        ${filterRows}
      </div>`;
  }).join('');

  _updateDashFilterBadge();
}

function _dashFilterRowHtml(f, idx, columns) {
  const op = FILTER_OPS.find(o => o.value === f.operator) || FILTER_OPS[0];
  const inputId = `dfi-${idx}`;
  const suggestId = `dfs-${idx}`;
  let valueHtml = '';

  if (op.hasValue) {
    if (SINGLE_VALUE_OPS.has(op.value)) {
      const v = Array.isArray(f.value) ? (f.value[0] || '') : (f.value || '');
      const dashDsObj = datasets.find(d => d.id === f.dataset_id);
      const dashColIsDate = (() => {
        if (transformState[f.dataset_id]?.[f.column]?.type === 'date') return true;
        const cm = dashDsObj?.columns?.find(c => c.name === f.column);
        if (cm?.type === 'date') return true;
        const cached = _colValuesCache[`${f.dataset_id}:${f.column}`];
        if (cached?.length) return looksLikeDates(cached.slice(0, 30));
        return false;
      })();
      if (dashColIsDate) {
        valueHtml = `
          <input class="filter-val" id="${inputId}" type="date" value="${escapeHtml(String(v))}"
            data-dash-idx="${idx}"
            onchange="dashFilterEditing[${idx}].value = this.value"
            style="flex:1;color-scheme:dark" />`;
      } else {
        valueHtml = `
          <div class="filter-ac-wrap">
            <input class="filter-val" id="${inputId}" type="text" placeholder="Value" value="${escapeHtml(String(v))}"
              oninput="onDashFilterInput(this,${idx},'${suggestId}')"
              onkeydown="onDashFilterKeydown(event,${idx},'${suggestId}','${inputId}')"
              onblur="onDashFilterSingleBlur(this,${idx},'${suggestId}')"
              data-dash-idx="${idx}"
              autocomplete="off" />
            <div class="filter-suggestions" id="${suggestId}"></div>
          </div>`;
      }
    } else {
      const tags = Array.isArray(f.value) ? f.value
        : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
      const tagsHtml = tags.map((t, ti) =>
        `<span class="filter-tag">${escapeHtml(t)}<button type="button" tabindex="-1"
          onmousedown="removeDashFilterTag(${idx},${ti},event)">×</button></span>`
      ).join('');
      valueHtml = `
        <div class="filter-tags-wrap" onclick="document.getElementById('${inputId}').focus()">
          ${tagsHtml}
          <div class="filter-ac-wrap">
            <input class="filter-tag-input" id="${inputId}" type="text" placeholder="${tags.length ? '' : 'Type &amp; Enter…'}"
              oninput="onDashFilterInput(this,${idx},'${suggestId}')"
              onkeydown="onDashFilterKeydown(event,${idx},'${suggestId}','${inputId}')"
              onblur="if(!_suggestMousedown) hideFilterSuggest('${suggestId}',0)"
              autocomplete="off" />
            <div class="filter-suggestions" id="${suggestId}"></div>
          </div>
        </div>`;
    }
  } else {
    valueHtml = `<span class="filter-val-empty"></span>`;
  }

  const colOpts = columns.map(c =>
    `<option value="${escapeHtml(c.name)}" ${c.name === f.column ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');

  return `
    <div class="filter-row" data-dash-idx="${idx}">
      <select class="filter-col" onchange="updateDashFilter(${idx},'column',this.value)">
        ${colOpts}
      </select>
      <select class="filter-op" onchange="updateDashFilter(${idx},'operator',this.value)">
        ${FILTER_OPS.map(o => `<option value="${o.value}" ${o.value === f.operator ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      ${valueHtml}
      <button class="icon-btn danger" onclick="removeDashFilter(${idx})"><i class="fa fa-times"></i></button>
    </div>`;
}

function addDashboardFilter() {
  // Prefer the first dataset that widgets use; fallback to first available
  const usedDsId = datasets[0]?.id || null;
  if (!usedDsId) return;
  const ds = datasets.find(d => d.id === usedDsId);
  dashFilterEditing.push({
    id: Date.now(),
    dataset_id: usedDsId,
    column: ds?.columns[0]?.name || '',
    operator: 'equals',
    value: ''
  });
  _renderDashFilterPanel();
}

function addDashboardFilterForDataset(dsId) {
  const ds = datasets.find(d => d.id === parseInt(dsId));
  if (!ds) return;
  dashFilterEditing.push({
    id: Date.now(),
    dataset_id: ds.id,
    column: ds.columns[0]?.name || '',
    operator: 'equals',
    value: ''
  });
  _renderDashFilterPanel();
}

function updateDashFilter(idx, key, value) {
  if (!dashFilterEditing[idx]) return;
  dashFilterEditing[idx][key] = value;
  if (key === 'column') dashFilterEditing[idx].value = '';
  if (key === 'column' || key === 'operator') _renderDashFilterPanel();
}

function removeDashFilter(idx) {
  dashFilterEditing.splice(idx, 1);
  _renderDashFilterPanel();
}

function removeDashFilterTag(idx, tagIdx, event) {
  event.preventDefault(); event.stopPropagation();
  const f = dashFilterEditing[idx];
  if (!f) return;
  const current = Array.isArray(f.value) ? [...f.value]
    : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
  current.splice(tagIdx, 1);
  dashFilterEditing[idx].value = current;
  _renderDashFilterPanel();
}

async function onDashFilterInput(input, idx, suggestId) {
  const f = dashFilterEditing[idx];
  if (!f) return;
  const op = FILTER_OPS.find(o => o.value === f.operator);
  if (op && SINGLE_VALUE_OPS.has(op.value)) dashFilterEditing[idx].value = input.value;
  const query = input.value.trim().toLowerCase();
  const allVals = await fetchColumnValues(f.dataset_id, f.column);
  const filtered = allVals.filter(v => !query || v.toLowerCase().includes(query)).slice(0, 10);
  showDashFilterSuggestions(suggestId, filtered, idx, input.id);
}

function onDashFilterSingleBlur(input, idx, suggestId) {
  if (dashFilterEditing[idx]) dashFilterEditing[idx].value = input.value;
  if (!_suggestMousedown) hideFilterSuggest(suggestId, 0);
}

function onDashFilterKeydown(e, idx, suggestId, inputId) {
  const suggest = document.getElementById(suggestId);
  const active = suggest?.querySelector('.suggest-item.active');
  if (e.key === 'Enter') {
    e.preventDefault();
    if (active) { active.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }
    else {
      const v = document.getElementById(inputId)?.value?.trim();
      if (v) applyDashFilterSuggestion(idx, suggestId, inputId, v);
    }
    return;
  }
  if (!suggest?.children.length) return;
  const items = suggest.querySelectorAll('.suggest-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = active ? (active.nextElementSibling || items[0]) : items[0];
    active?.classList.remove('active'); next?.classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = active ? (active.previousElementSibling || items[items.length-1]) : items[items.length-1];
    active?.classList.remove('active'); prev?.classList.add('active');
  } else if (e.key === 'Escape') {
    hideFilterSuggest(suggestId, 0);
  }
}

function showDashFilterSuggestions(suggestId, values, idx, inputId) {
  const suggest = document.getElementById(suggestId);
  if (!suggest) return;
  if (!values.length) { suggest.innerHTML = ''; return; }
  suggest.innerHTML = values.map(v => `<div class="suggest-item">${escapeHtml(v)}</div>`).join('');
  suggest.querySelectorAll('.suggest-item').forEach((el, i) => {
    const v = values[i];
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _suggestMousedown = true;
      applyDashFilterSuggestion(idx, suggestId, inputId, v);
      _suggestMousedown = false;
    });
  });
}

function applyDashFilterSuggestion(idx, suggestId, inputId, value) {
  const f = dashFilterEditing[idx];
  if (!f) return;
  const op = FILTER_OPS.find(o => o.value === f.operator);
  if (op && !SINGLE_VALUE_OPS.has(op.value)) {
    const current = Array.isArray(f.value) ? [...f.value]
      : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
    if (!current.includes(value)) { current.push(value); dashFilterEditing[idx].value = current; }
    const input = document.getElementById(inputId);
    if (input) { input.value = ''; input.focus(); }
    hideFilterSuggest(suggestId, 0);
    _renderDashFilterPanel();
  } else {
    dashFilterEditing[idx].value = value;
    const input = document.getElementById(inputId);
    if (input) input.value = value;
    hideFilterSuggest(suggestId, 0);
  }
}

async function applyDashboardFilters() {
  // Flush any partially-typed values from live input elements into dashFilterEditing
  // before committing. This handles the case where the user types a value but
  // hasn't pressed Enter or clicked a suggestion.
  _flushDashFilterInputs();

  // Commit working copy to live state
  dashboardFilters = dashFilterEditing.map(f => ({ ...f }));
  _updateDashFilterBadge();
  // Persist to server so filters survive page refresh
  await _saveDashboardFiltersToServer();

  closeAllPanels();
  await Promise.all(widgets.map(w => renderWidget(w)));
}

async function _saveDashboardFiltersToServer() {
  try {
    const toSave = dashboardFilters.map(f => ({
      dataset_id: f.dataset_id,
      column:     f.column,
      operator:   f.operator,
      value:      f.value,
    }));
    await fetch(`/api/dashboard/${DASHBOARD_UID}/filters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: toSave }),
    });
  } catch (e) {
    console.warn('Could not save dashboard filters:', e);
  }
}

// Reads all visible filter input elements and pushes their current typed value
// into dashFilterEditing so nothing is lost when Apply is clicked.
function _flushDashFilterInputs() {
  document.querySelectorAll('#dashFilterRows .filter-row').forEach((row) => {
    const idx = parseInt(row.dataset.dashIdx);
    if (isNaN(idx)) return;
    const f = dashFilterEditing[idx];
    if (!f) return;
    const op = FILTER_OPS.find(o => o.value === f.operator);
    if (!op || !op.hasValue) return;

    if (SINGLE_VALUE_OPS.has(op.value)) {
      // Plain or date input: just read current value
      const input = row.querySelector('input.filter-val');
      if (input) f.value = input.value;
    } else {
      // Tag input: if there's text in the tag input that hasn't been committed,
      // commit it as a tag now so the user doesn't lose it
      const input = row.querySelector('input.filter-tag-input');
      if (input && input.value.trim()) {
        const typed = input.value.trim();
        const current = Array.isArray(f.value) ? [...f.value]
          : (f.value ? String(f.value).split(',').map(s => s.trim()).filter(Boolean) : []);
        if (!current.includes(typed)) current.push(typed);
        f.value = current;
        input.value = '';
      }
    }
  });
}

async function clearDashboardFilters() {
  dashFilterEditing = [];
  dashboardFilters = [];
  _updateDashFilterBadge();
  await _saveDashboardFiltersToServer();
  _renderDashFilterPanel();
  await Promise.all(widgets.map(w => renderWidget(w)));
}

function _updateDashFilterBadge() {
  const badge = document.getElementById('dashFilterBadge');
  const btn = document.getElementById('dashFilterBtn');
  if (!badge || !btn) return;
  const count = dashboardFilters.length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
  btn.classList.toggle('dash-filter-active', count > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT — HTML & PDF
// ═══════════════════════════════════════════════════════════════════════════

function toggleExportMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('exportMenu');
  menu.classList.toggle('open');
}
document.addEventListener('click', () => {
  document.getElementById('exportMenu')?.classList.remove('open');
});

function _showExportOverlay(msg) {
  const ov = document.getElementById('exportOverlay');
  document.getElementById('exportMsg').textContent = msg;
  ov.classList.add('active');
}
function _hideExportOverlay() {
  document.getElementById('exportOverlay').classList.remove('active');
}

// ── HTML Export ────────────────────────────────────────────────────────────
// Captures every Plotly chart as an inline SVG, inlines all stylesheets,
// and produces a fully self-contained HTML file that works offline.
async function exportHTML() {
  document.getElementById('exportMenu').classList.remove('open');
  _showExportOverlay('Building HTML snapshot…');
  await new Promise(r => setTimeout(r, 60)); // let overlay render

  try {
    const dashTitle = document.getElementById('dashTitle')?.textContent || 'Dashboard';

    // 1. Collect all inline <style> + external stylesheet text
    let styleText = '';
    for (const sheet of document.styleSheets) {
      try {
        const rules = [...sheet.cssRules].map(r => r.cssText).join('\n');
        styleText += rules + '\n';
      } catch { /* cross-origin sheets — skip */ }
    }

    // 2. Snapshot every Plotly chart to SVG
    // Replace each .widget-plot div with an <img> of the SVG data URL
    const plotDivs = document.querySelectorAll('.widget-plot');
    const svgSwaps = []; // { div, originalHTML }
    for (const div of plotDivs) {
      try {
        const svgData = await Plotly.toImage(div, { format: 'svg', width: div.offsetWidth || 400, height: div.offsetHeight || 260 });
        const img = document.createElement('img');
        img.src = svgData;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
        svgSwaps.push({ div, originalHTML: div.innerHTML });
        div.innerHTML = '';
        div.appendChild(img);
      } catch { /* widget may have no chart yet */ }
    }

    // 3. Clone the grid canvas only (not panels/sidebars)
    const canvas = document.getElementById('dashCanvas');
    const clone = canvas.cloneNode(true);

    // Remove action buttons from clone
    clone.querySelectorAll('.widget-actions, .edit-title-btn, .dash-topbar').forEach(el => el.remove());

    // 4. Build the self-contained HTML document
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(dashTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    ${styleText}
    /* Export overrides */
    body { overflow: auto !important; background: #0d0f14; }
    .dash-canvas { padding: 20px; overflow: visible !important; height: auto !important; }
    .grid-stack { height: auto !important; }
    .widget-actions { display: none !important; }
    .export-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; background: #13161e; border-bottom: 1px solid #2a2f45;
      margin-bottom: 0;
    }
    .export-header h1 { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 700; color: #e2e8f0; margin:0; }
    .export-header small { color: #64748b; font-size: 12px; }
    .export-brand { display:flex; align-items:center; gap:8px; color:#6366f1; font-size:13px; font-weight:600; }
  </style>
</head>
<body>
  <div class="export-header">
    <div>
      <h1>${escapeHtml(dashTitle)}</h1>
      <small>Exported ${new Date().toLocaleString()}</small>
    </div>
    <div class="export-brand">◈ DataLens</div>
  </div>
  <div style="padding:20px">
    ${clone.innerHTML}
  </div>
</body>
</html>`;

    // 5. Restore original Plotly divs
    for (const { div, originalHTML } of svgSwaps) {
      div.innerHTML = originalHTML;
    }

    // 6. Trigger download
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    _triggerDownload(blob, `${dashTitle.replace(/[^a-z0-9]/gi, '_')}.html`);

  } catch (e) {
    console.error('HTML export error:', e);
    alert('Export failed: ' + e.message);
  } finally {
    _hideExportOverlay();
  }
}

// ── PDF Export ─────────────────────────────────────────────────────────────
// Uses html2canvas to rasterise the live dashboard grid, then jsPDF to build
// a landscape A4 PDF with a branded header and the chart image.
async function exportPDF() {
  document.getElementById('exportMenu').classList.remove('open');

  if (typeof html2canvas === 'undefined' || typeof jspdf === 'undefined') {
    alert('PDF export libraries are still loading — please try again in a moment.');
    return;
  }

  _showExportOverlay('Rendering charts…');
  await new Promise(r => setTimeout(r, 80));

  try {
    const dashTitle = document.getElementById('dashTitle')?.textContent || 'Dashboard';
    const canvas = document.getElementById('dashCanvas');

    _showExportOverlay('Capturing dashboard…');

    // Temporarily hide widget action buttons so they don't appear in screenshot
    const actionEls = document.querySelectorAll('.widget-actions');
    actionEls.forEach(el => el.style.visibility = 'hidden');

    const canvasEl = await html2canvas(canvas, {
      backgroundColor: '#0d0f14',
      scale: 2,           // retina quality
      useCORS: true,
      logging: false,
      scrollX: 0,
      scrollY: -window.scrollY,
      windowWidth: canvas.scrollWidth,
      windowHeight: canvas.scrollHeight,
    });

    actionEls.forEach(el => el.style.visibility = '');

    _showExportOverlay('Building PDF…');
    await new Promise(r => setTimeout(r, 30));

    const { jsPDF } = jspdf;
    const imgData = canvasEl.toDataURL('image/jpeg', 0.92);

    // Layout: landscape A4 = 297 × 210 mm
    // Header height = 18mm, content fills the rest
    const PAGE_W = 297, PAGE_H = 210;
    const HEADER_H = 18, MARGIN = 8;
    const CONTENT_H = PAGE_H - HEADER_H - MARGIN * 2;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    // Calculate how many PDF pages we need (dashboard may be taller than one page)
    const dashAspect = canvasEl.height / canvasEl.width;
    const totalImgH = CONTENT_W * dashAspect; // mm when image fills width
    const totalPages = Math.ceil(totalImgH / CONTENT_H);

    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) pdf.addPage();

      // ── Header bar ───────────────────────────────────────────────────────
      pdf.setFillColor(19, 22, 30);         // --bg2
      pdf.rect(0, 0, PAGE_W, HEADER_H, 'F');

      // Brand mark
      pdf.setTextColor(99, 102, 241);       // --accent
      pdf.setFontSize(13);
      pdf.setFont('helvetica', 'bold');
      pdf.text('◈', MARGIN, 12);

      pdf.setTextColor(99, 102, 241);
      pdf.setFontSize(11);
      pdf.text('DataLens', MARGIN + 6, 12);

      // Dashboard title
      pdf.setTextColor(226, 232, 240);      // --text
      pdf.setFontSize(13);
      pdf.setFont('helvetica', 'bold');
      pdf.text(dashTitle, PAGE_W / 2, 12, { align: 'center' });

      // Date + page number
      pdf.setTextColor(100, 116, 139);      // --text3
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      const dateStr = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
      pdf.text(dateStr, PAGE_W - MARGIN, 8, { align: 'right' });
      if (totalPages > 1) {
        pdf.text(`Page ${page + 1} / ${totalPages}`, PAGE_W - MARGIN, 14, { align: 'right' });
      }

      // Thin accent line under header
      pdf.setDrawColor(99, 102, 241);
      pdf.setLineWidth(0.4);
      pdf.line(0, HEADER_H, PAGE_W, HEADER_H);

      // ── Chart image slice ─────────────────────────────────────────────────
      const sliceY      = page * CONTENT_H;          // mm offset in the full image
      const slicePixelY = (sliceY / totalImgH) * canvasEl.height;
      const slicePixelH = (CONTENT_H / totalImgH) * canvasEl.height;

      // Crop this slice from the source canvas
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width  = canvasEl.width;
      sliceCanvas.height = Math.min(slicePixelH, canvasEl.height - slicePixelY);
      const ctx = sliceCanvas.getContext('2d');
      ctx.drawImage(canvasEl, 0, slicePixelY, sliceCanvas.width, sliceCanvas.height, 0, 0, sliceCanvas.width, sliceCanvas.height);

      const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
      const sliceH_mm = (sliceCanvas.height / canvasEl.height) * totalImgH;

      pdf.addImage(sliceData, 'JPEG', MARGIN, HEADER_H + MARGIN, CONTENT_W, sliceH_mm);
    }

    pdf.save(`${dashTitle.replace(/[^a-z0-9]/gi, '_')}.pdf`);

  } catch (e) {
    console.error('PDF export error:', e);
    alert('PDF export failed: ' + e.message);
  } finally {
    _hideExportOverlay();
  }
}

// ── Shared download helper ─────────────────────────────────────────────────
function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
}
// ═══════════════════════════════════════════════════════════════════════════
// TRANSFORM PANEL
// ═══════════════════════════════════════════════════════════════════════════

let transformState = {}; // { datasetId: { colName: { type, ... } } }
let _transformDsId = null;

const DATE_FORMATS = [
  { value: '',           label: 'Auto-detect' },
  { value: '%Y-%m-%d',   label: 'YYYY-MM-DD  (2024-01-31)' },
  { value: '%d/%m/%Y',   label: 'DD/MM/YYYY  (31/01/2024)' },
  { value: '%m/%d/%Y',   label: 'MM/DD/YYYY  (01/31/2024)' },
  { value: '%d-%m-%Y',   label: 'DD-MM-YYYY  (31-01-2024)' },
  { value: '%d.%m.%Y',   label: 'DD.MM.YYYY  (31.01.2024)' },
  { value: '%Y/%m/%d',   label: 'YYYY/MM/DD  (2024/01/31)' },
  { value: '%B %d, %Y',  label: 'Month DD, YYYY  (January 31, 2024)' },
  { value: '%b %d, %Y',  label: 'Mon DD, YYYY  (Jan 31, 2024)' },
  { value: '%d %B %Y',   label: 'DD Month YYYY  (31 January 2024)' },
  { value: '%Y-%m-%dT%H:%M:%S', label: 'ISO datetime  (2024-01-31T12:00:00)' },
  { value: '%d/%m/%Y %H:%M',    label: 'DD/MM/YYYY HH:MM' },
];

const DATE_TRUNC = [
  { value: '',        label: 'No grouping (exact date)' },
  { value: 'day',     label: 'Day' },
  { value: 'week',    label: 'Week (Mon–Sun)' },
  { value: 'month',   label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year',    label: 'Year' },
];

const DATE_OUTPUT_FORMATS = [
  { value: '%Y-%m-%d',  label: 'YYYY-MM-DD' },
  { value: '%d/%m/%Y',  label: 'DD/MM/YYYY' },
  { value: '%b %Y',     label: 'Mon YYYY  (Jan 2024)' },
  { value: '%B %Y',     label: 'Month YYYY  (January 2024)' },
  { value: "Q%q %Y",    label: 'Q1 2024 (quarter label)' },
  { value: '%Y',        label: 'YYYY' },
  { value: '%d %b %Y',  label: 'DD Mon YYYY' },
];

function showTransformPanel() {
  // Populate dataset selector
  const sel = document.getElementById('transformDsSelect');
  sel.innerHTML = datasets.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  _transformDsId = datasets[0]?.id || null;
  if (_transformDsId) loadTransformColumns();
  openPanel('transformPanel');
}

function closeTransformPanel() { closeAllPanels(); }

async function loadTransformColumns() {
  const dsId = parseInt(document.getElementById('transformDsSelect').value);
  _transformDsId = dsId;
  const wrap = document.getElementById('transformColumnsWrap');
  wrap.innerHTML = '<div class="widget-loading"><i class="fa fa-spinner fa-spin"></i> Loading…</div>';

  try {
    const res = await fetch(`/api/dataset/${dsId}/transforms`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (!transformState[dsId]) transformState[dsId] = data.transforms || {};

    renderTransformColumns(data.columns, transformState[dsId]);
  } catch(e) {
    wrap.innerHTML = `<div class="widget-error">${escapeHtml(e.message)}</div>`;
  }
}

function renderTransformColumns(columns, transforms) {
  const wrap = document.getElementById('transformColumnsWrap');
  if (!columns.length) { wrap.innerHTML = '<p style="color:var(--text3);padding:16px">No columns found.</p>'; return; }

  wrap.innerHTML = `
    <div class="transform-table">
      <div class="transform-table-head">
        <span>Column</span><span>Original Type</span><span>Transform</span>
      </div>
      ${columns.map(col => renderTransformRow(col, transforms[col.name] || {})).join('')}
    </div>`;
}

function renderTransformRow(col, t) {
  const dsId = _transformDsId;
  const cname = escapeHtml(col.name);
  const type = t.type || 'auto';
  const isDate = type === 'date';
  const isNumber = type === 'number';
  const isText = type === 'text';
  const isRename = type === 'rename';
  const isExclude = type === 'exclude';

  const badgeColor = { numeric:'#10b981', text:'#6366f1', date:'#f59e0b', auto:'#64748b' };
  const badge = `<span class="type-badge" style="background:${badgeColor[col.type]||'#64748b'}">${col.type}</span>`;

  const rowId = `tr-${dsId}-${col.name.replace(/[^a-z0-9]/gi,'_')}`;

  return `
    <div class="transform-row" id="${rowId}">
      <div class="transform-col-name">
        <span class="col-name-text">${cname}</span>
        ${badge}
      </div>
      <div class="transform-col-orig">${col.dtype}</div>
      <div class="transform-col-config">
        <select class="transform-type-sel" onchange="onTransformTypeChange('${col.name}', this.value, '${rowId}')">
          <option value="auto"   ${type==='auto'   ?'selected':''}>— No change</option>
          <option value="date"   ${type==='date'   ?'selected':''}>📅 Parse as Date</option>
          <option value="number" ${type==='number' ?'selected':''}>🔢 Parse as Number</option>
          <option value="text"   ${type==='text'   ?'selected':''}>🔤 Format Text</option>
          <option value="rename" ${type==='rename' ?'selected':''}>✏️ Rename</option>
          <option value="exclude"${type==='exclude'?'selected':''}>🚫 Exclude Column</option>
        </select>

        ${isDate ? `
          <div class="transform-sub">
            <label>Input Date Format</label>
            <select onchange="updateTransformField('${col.name}','date_format',this.value)">
              ${DATE_FORMATS.map(f => `<option value="${f.value}" ${(t.date_format||'')=== f.value?'selected':''}>${escapeHtml(f.label)}</option>`).join('')}
            </select>
            <label>Group By</label>
            <select onchange="updateTransformField('${col.name}','date_trunc',this.value)">
              ${DATE_TRUNC.map(f => `<option value="${f.value}" ${(t.date_trunc||'')=== f.value?'selected':''}>${f.label}</option>`).join('')}
            </select>
            <label>Output Format</label>
            <select onchange="updateTransformField('${col.name}','date_output_format',this.value)">
              ${DATE_OUTPUT_FORMATS.map(f => `<option value="${f.value}" ${(t.date_output_format||'%Y-%m-%d')=== f.value?'selected':''}>${escapeHtml(f.label)}</option>`).join('')}
            </select>
          </div>` : ''}

        ${isNumber ? `
          <div class="transform-sub">
            <label>Fill empty with</label>
            <input type="text" placeholder="e.g. 0 (leave blank to keep null)"
              value="${escapeHtml(t.fill_null||'')}"
              onchange="updateTransformField('${col.name}','fill_null',this.value)" />
          </div>` : ''}

        ${isText ? `
          <div class="transform-sub">
            <label>Case Transform</label>
            <select onchange="updateTransformField('${col.name}','text_case',this.value)">
              <option value=""      ${!t.text_case?'selected':''}>— None</option>
              <option value="strip" ${t.text_case==='strip'?'selected':''}>Trim whitespace</option>
              <option value="upper" ${t.text_case==='upper'?'selected':''}>UPPERCASE</option>
              <option value="lower" ${t.text_case==='lower'?'selected':''}>lowercase</option>
              <option value="title" ${t.text_case==='title'?'selected':''}>Title Case</option>
            </select>
            <label>Fill empty with</label>
            <input type="text" placeholder="e.g. N/A"
              value="${escapeHtml(t.fill_null||'')}"
              onchange="updateTransformField('${col.name}','fill_null',this.value)" />
          </div>` : ''}

        ${isRename ? `
          <div class="transform-sub">
            <label>New column name</label>
            <input type="text" placeholder="New name…"
              value="${escapeHtml(t.rename_to||col.name)}"
              onchange="updateTransformField('${col.name}','rename_to',this.value)" />
          </div>` : ''}

        ${isExclude ? `<p class="transform-exclude-note">This column will be hidden from all charts and filters.</p>` : ''}
      </div>
    </div>`;
}

function onTransformTypeChange(colName, newType, rowId) {
  const dsId = _transformDsId;
  if (!transformState[dsId]) transformState[dsId] = {};
  if (newType === 'auto') {
    delete transformState[dsId][colName];
  } else {
    transformState[dsId][colName] = { type: newType };
  }
  // Re-fetch columns meta and re-render just this row
  const ds = datasets.find(d => d.id === dsId);
  if (!ds) return;
  const col = ds.columns.find(c => c.name === colName);
  if (!col) return;
  const rowEl = document.getElementById(rowId);
  if (rowEl) rowEl.outerHTML = renderTransformRow(col, transformState[dsId][colName] || {});
}

function updateTransformField(colName, field, value) {
  const dsId = _transformDsId;
  if (!transformState[dsId]) transformState[dsId] = {};
  if (!transformState[dsId][colName]) transformState[dsId][colName] = {};
  transformState[dsId][colName][field] = value;
}

async function previewTransforms() {
  const dsId = _transformDsId;
  if (!dsId) return;
  const transforms = transformState[dsId] || {};
  const filtered = Object.fromEntries(Object.entries(transforms).filter(([,v]) => v.type && v.type !== 'auto'));

  const url = `/api/dataset/${dsId}/data?limit=10&transforms=${encodeURIComponent(JSON.stringify(filtered))}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showTransformPreview(data);
  } catch(e) {
    alert('Preview error: ' + e.message);
  }
}

function showTransformPreview(data) {
  const existing = document.getElementById('transformPreviewWrap');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'transformPreviewWrap';
  wrap.innerHTML = `
    <div class="transform-preview-header">
      <span>Preview (first 10 rows after transforms)</span>
      <button class="icon-btn" onclick="document.getElementById('transformPreviewWrap').remove()">
        <i class="fa fa-times"></i>
      </button>
    </div>
    <div class="transform-preview-table-wrap">
      <table class="data-table">
        <thead><tr>${data.columns.map(c => `<th>${escapeHtml(String(c))}</th>`).join('')}</tr></thead>
        <tbody>${data.data.map(row =>
          `<tr>${row.map(cell => `<td>${cell === null ? '<span style="color:var(--text3)">null</span>' : escapeHtml(String(cell))}</td>`).join('')}</tr>`
        ).join('')}</tbody>
      </table>
    </div>`;

  document.getElementById('transformBody').appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveTransforms() {
  const dsId = _transformDsId;
  if (!dsId) return;
  const transforms = transformState[dsId] || {};
  const filtered = Object.fromEntries(Object.entries(transforms).filter(([,v]) => v.type && v.type !== 'auto'));

  const btn = document.querySelector('#transformPanel .btn-primary');
  btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Saving…';

  try {
    const res = await fetch(`/api/dataset/${dsId}/transforms`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transforms: filtered })
    });
    const data = await res.json();
    if (!data.ok) throw new Error('Save failed');

    // Invalidate column values cache for this dataset
    Object.keys(_colValuesCache).forEach(k => { if (k.startsWith(dsId + ':')) delete _colValuesCache[k]; });

    // Re-render all widgets using this dataset
    const affected = widgets.filter(w => w.dataset_id === dsId);
    await Promise.all(affected.map(w => renderWidget(w)));

    btn.innerHTML = '<i class="fa fa-check"></i> Saved!';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa fa-check"></i> Apply & Save';
      closeTransformPanel();
    }, 800);
  } catch(e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa fa-check"></i> Apply & Save';
  }
}

// Show Transform button when datasets are loaded
function updateTransformBtn() {
  const btn = document.getElementById('transformBtn');
  if (btn) btn.style.display = datasets.length > 0 ? 'inline-flex' : 'none';
}

// updateTransformBtn is called directly from populateDatasetSelects below