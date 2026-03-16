// ── State ──────────────────────────────────────────────────────────────────
let entries     = JSON.parse(localStorage.getItem('bujo') || '[]');
let weekOffset  = 0;
let monthOffset = 0;
let monthShowAll = false;
let activeTab   = 'daily';
let undoStack   = [];   // [{entry, idx}, …]  max 10
let draggedId   = null;

function save() { localStorage.setItem('bujo', JSON.stringify(entries)); }

// ── Date helpers ───────────────────────────────────────────────────────────
function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayKey() { return toKey(new Date()); }

function weekMonday(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset * 7);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0,0,0,0);
  return d;
}
function weekDays(offset = 0) {
  const m = weekMonday(offset);
  return Array.from({length:7}, (_,i) => { const d=new Date(m); d.setDate(m.getDate()+i); return d; });
}
function weekTaskKey(offset = 0) {
  const m = weekMonday(offset);
  return `W-${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}-${String(m.getDate()).padStart(2,'0')}`;
}
function monthTaskKey(offset = 0) {
  const d = new Date(); d.setMonth(d.getMonth() + offset);
  return `M-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function monthDays(offset = 0) {
  const d = new Date(); d.setMonth(d.getMonth() + offset, 1);
  const count = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
  return Array.from({length:count}, (_,i) => new Date(d.getFullYear(), d.getMonth(), i+1));
}
function groupByWeek(days) {
  const groups = []; let cur = null;
  days.forEach(d => {
    const iso = isoWeek(d);
    if (!cur || cur.iso !== iso) { cur = {iso, days:[]}; groups.push(cur); }
    cur.days.push(d);
  });
  return groups;
}
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - ys) / 86400000) + 1) / 7);
}

// ── Input parsing ──────────────────────────────────────────────────────────
// Prefix syntax:  "- text" → note  |  "o text" → event  |  "! text" → priority task
function parseInput(raw) {
  const t = raw.trim();
  if (/^-\s+\S/.test(t))    return { type:'note',  priority:false, text: t.slice(t.indexOf(' ')+1).trimStart() };
  if (/^[oO]\s+\S/.test(t)) return { type:'event', priority:false, text: t.slice(t.indexOf(' ')+1).trimStart() };
  if (/^!\s+\S/.test(t))    return { type:'task',  priority:true,  text: t.slice(t.indexOf(' ')+1).trimStart() };
  return { type:'task', priority:false, text: t };
}
function previewSym(raw) {
  const t = raw.trim();
  if (/^-\s/.test(t))    return '–';
  if (/^[oO]\s/.test(t)) return '○';
  if (/^!\s/.test(t))    return '★';
  return '•';
}

// ── Symbol helpers ────────────────────────────────────────────────────────
const STATUS_SYM = { open:'•', completed:'×', migrated:'›' };
const TYPE_SYM   = { task:'•', event:'○', note:'–' };
function symbolFor(e) {
  return e.type === 'task' ? (STATUS_SYM[e.status] ?? '•') : (TYPE_SYM[e.type] ?? '•');
}

// ── Delete + undo ──────────────────────────────────────────────────────────
function deleteEntry(id) {
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  undoStack.push({ entry: {...entries[idx]}, idx });
  if (undoStack.length > 10) undoStack.shift();
  entries.splice(idx, 1);
  save();
  render(activeTab);
  showToast();
}
function undoDelete() {
  if (!undoStack.length) return;
  const { entry, idx } = undoStack.pop();
  entries.splice(idx, 0, entry);
  save();
  render(activeTab);
  hideToast();
}

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer;
function showToast() {
  const t = document.getElementById('undo-toast');
  t.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() {
  document.getElementById('undo-toast').classList.remove('visible');
}
document.getElementById('undo-btn').addEventListener('click', undoDelete);

// ── makeEntryEl ────────────────────────────────────────────────────────────
function makeEntryEl(entry, opts = {}) {
  const li = document.createElement('li');
  li.className = ['entry',
    entry.status === 'completed' ? 'completed' : '',
    entry.status === 'migrated'  ? 'migrated'  : '',
    entry.priority               ? 'priority'  : '',
  ].filter(Boolean).join(' ');

  // ── Draggable ──
  li.draggable = true;
  li.addEventListener('dragstart', e => {
    draggedId = entry.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.id);
    setTimeout(() => li.classList.add('dragging'), 0);
    document.body.classList.add('is-dragging');
  });
  li.addEventListener('dragend', () => {
    draggedId = null;
    li.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    document.querySelectorAll('.drag-over').forEach(z => z.classList.remove('drag-over'));
  });

  // Symbol — click to cycle status for tasks
  const sym = document.createElement('span');
  sym.className = 'entry-symbol' + (entry.type === 'task' ? ' clickable' : '');
  sym.textContent = symbolFor(entry);
  if (entry.type === 'task') {
    sym.title = 'Cycle: open → done → migrated';
    sym.addEventListener('click', () => {
      const cycle = { open:'completed', completed:'migrated', migrated:'open' };
      entry.status = cycle[entry.status] ?? 'completed';
      save(); render(activeTab);
    });
  }

  // Text — double-click to edit inline
  const txt = document.createElement('span');
  txt.className = 'entry-text';
  txt.textContent = entry.text;
  txt.title = 'Double-click to edit';
  txt.addEventListener('dblclick', () => startInlineEdit(entry, txt));

  // Actions
  const acts = document.createElement('div');
  acts.className = 'entry-actions';

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'btn-icon star' + (entry.priority ? ' active' : '');
  star.textContent = '★'; star.title = 'Toggle priority';
  star.addEventListener('click', () => { entry.priority = !entry.priority; save(); render(activeTab); });
  acts.append(star);

  // "Pull to today" — shown in backlog carry-forward sections
  if (opts.pullToToday && entry.type === 'task' && entry.status === 'open') {
    const pull = document.createElement('button');
    pull.type = 'button';
    pull.className = 'btn-icon pull';
    pull.textContent = '→'; pull.title = 'Move to today';
    pull.addEventListener('click', () => { entry.day = todayKey(); save(); render(activeTab); });
    acts.append(pull);
  }

  // "+1" — move to tomorrow (all open/migrated tasks)
  if (entry.type === 'task' && entry.status !== 'completed') {
    const tom = document.createElement('button');
    tom.type = 'button';
    tom.className = 'btn-icon tomorrow';
    tom.textContent = '+1'; tom.title = 'Move to tomorrow';
    tom.addEventListener('click', () => {
      const base = (entry.day && entry.day.length === 10)
        ? new Date(entry.day + 'T12:00:00')
        : new Date();
      base.setDate(base.getDate() + 1);
      entry.day = toKey(base);
      entry.status = 'open';
      save(); render(activeTab);
    });
    acts.append(tom);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-icon del';
  del.textContent = '✕'; del.title = 'Delete';
  del.addEventListener('click', () => deleteEntry(entry.id));
  acts.append(del);

  li.append(sym, txt, acts);
  return li;
}

// ── Inline edit ────────────────────────────────────────────────────────────
function startInlineEdit(entry, txtEl) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'inline-edit';
  inp.value = entry.text;
  txtEl.replaceWith(inp);
  inp.focus(); inp.select();

  const commit = () => {
    const val = inp.value.trim();
    if (val) entry.text = val;
    save(); render(activeTab);
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); render(activeTab); }
  });
}

// ── fill ───────────────────────────────────────────────────────────────────
function fill(listEl, items, opts = {}) {
  listEl.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = opts.emptyText || 'Nothing here.';
    listEl.appendChild(d);
  } else {
    items.forEach(e => listEl.appendChild(makeEntryEl(e, opts)));
  }
}

// ── Day block (shared by weekly + calendar views) ──────────────────────────
function makeDayBlock(date, opts = {}) {
  const key      = toKey(date);
  const today    = todayKey();
  const isToday  = key === today;
  const isFuture = key > today;
  const dayEntries = entries.filter(e => e.day === key);

  const wrap = document.createElement('div');
  wrap.className = 'day-block';

  const row = document.createElement('div');
  row.className = 'day-row' + (isToday ? ' is-today' : '') + (isFuture ? ' is-future' : '');

  const dow = document.createElement('span');
  dow.className = 'day-dow';
  dow.textContent = date.toLocaleDateString('en-US', {weekday:'short'}).toUpperCase();

  const num = document.createElement('span');
  num.className = 'day-date-num';
  num.textContent = date.getDate();

  row.append(dow, num);
  if (isToday) {
    const pill = document.createElement('span');
    pill.className = 'today-pill'; pill.textContent = 'today';
    row.append(pill);
  }
  wrap.append(row);

  const ul = document.createElement('ul');
  ul.className = 'entry-list day-entries';
  if (!dayEntries.length && !opts.showQuickAdd) {
    const dash = document.createElement('div');
    dash.className = 'day-dash'; dash.textContent = '—';
    ul.appendChild(dash);
  } else {
    dayEntries.forEach(e => ul.appendChild(makeEntryEl(e)));
  }
  wrap.append(ul);

  if (opts.showQuickAdd) {
    const qa = document.createElement('div');
    qa.className = 'quick-add';

    const qSym = document.createElement('span');
    qSym.className = 'quick-sym'; qSym.textContent = '•';

    const qInp = document.createElement('input');
    qInp.className = 'quick-input';
    qInp.placeholder = 'Quick add…';
    qInp.autocomplete = 'off';

    const qBtn = document.createElement('button');
    qBtn.className = 'quick-go'; qBtn.type = 'button'; qBtn.textContent = '↵';

    qInp.addEventListener('input', () => {
      qSym.textContent = previewSym(qInp.value);
      qSym.style.color = /^!\s/.test(qInp.value.trim()) ? '#c0392b' : '#ddd';
    });

    const doAdd = () => {
      const raw = qInp.value.trim(); if (!raw) return;
      const { type, priority, text } = parseInput(raw);
      entries.push({ id: Date.now().toString(), type, text, status:'open', priority, day: key });
      save(); render(activeTab); qInp.value = '';
      qSym.textContent = '•'; qSym.style.color = '';
    };
    qBtn.addEventListener('click', doAdd);
    qInp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
    qa.append(qSym, qInp, qBtn);
    wrap.append(qa);
  }
  return wrap;
}

// ── Render: Daily ──────────────────────────────────────────────────────────
function renderDaily() {
  fill(document.getElementById('daily-list'),
       entries.filter(e => e.day === todayKey()),
       { emptyText: 'No entries yet — start logging your day.' });
}

// ── Render: Weekly ─────────────────────────────────────────────────────────
function renderWeekly() {
  const days = weekDays(weekOffset);
  const wKey = weekTaskKey(weekOffset);
  const fmt  = d => d.toLocaleDateString('en-US', {month:'short', day:'numeric'});

  document.getElementById('week-title').textContent =
    `Week of ${fmt(days[0])} – ${fmt(days[6])}, ${days[0].getFullYear()}`;
  document.getElementById('week-next').disabled = weekOffset >= 0;

  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  const yKey   = toKey(yesterday);
  const monday = toKey(days[0]);

  const backlog = entries.filter(e =>
    e.type==='task' && e.status==='open' &&
    e.day >= monday && e.day <= yKey && e.day.length===10);
  const backBlock = document.getElementById('week-backlog-block');
  fill(document.getElementById('week-backlog-list'), backlog, { pullToToday:true });
  backBlock.className = 'backlog-block' + (backlog.length ? '' : ' clear');

  fill(document.getElementById('week-tasks-list'),
       entries.filter(e => e.day === wKey),
       { emptyText: 'No tasks for this week yet.' });

  const container = document.getElementById('week-days');
  container.innerHTML = '';
  days.forEach(d => container.appendChild(makeDayBlock(d, { showQuickAdd:true })));
}

// ── Render: Calendar (monthly) ─────────────────────────────────────────────
function renderMonthly() {
  const days  = monthDays(monthOffset);
  const mKey  = monthTaskKey(monthOffset);
  const today = todayKey();
  const fmt   = d => d.toLocaleDateString('en-US', {month:'short', day:'numeric'});

  const refDate = new Date(); refDate.setMonth(refDate.getMonth()+monthOffset, 1);
  document.getElementById('month-title').textContent =
    refDate.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  document.getElementById('month-next').disabled = monthOffset >= 0;

  const firstKey  = toKey(days[0]);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  const yKey      = toKey(yesterday);

  const backlog = entries.filter(e =>
    e.type==='task' && e.status==='open' &&
    e.day >= firstKey && e.day <= yKey && e.day.length===10);
  const backBlock = document.getElementById('month-backlog-block');
  fill(document.getElementById('month-backlog-list'), backlog, { pullToToday:true });
  backBlock.className = 'backlog-block' + (backlog.length ? '' : ' clear');

  fill(document.getElementById('month-tasks-list'),
       entries.filter(e => e.day === mKey),
       { emptyText: 'No tasks for this month yet.' });

  // Compact: skip past empty days unless monthShowAll is true
  const container = document.getElementById('month-days');
  container.innerHTML = '';
  let hiddenCount = 0;

  groupByWeek(days).forEach((wk, i) => {
    const sep = document.createElement('div');
    sep.className = 'week-sep';
    sep.textContent = `Week ${i+1}  ·  ${fmt(wk.days[0])} – ${fmt(wk.days[wk.days.length-1])}`;
    container.appendChild(sep);

    wk.days.forEach(d => {
      const key        = toKey(d);
      const hasEntries = entries.some(e => e.day === key);
      const isPast     = key < today;
      if (!monthShowAll && isPast && !hasEntries) { hiddenCount++; return; }
      container.appendChild(makeDayBlock(d));
    });
  });

  const toggleRow = document.getElementById('month-show-all');
  if (hiddenCount > 0 && !monthShowAll) {
    toggleRow.textContent = `▸ Show ${hiddenCount} empty past day${hiddenCount>1?'s':''}`;
    toggleRow.onclick = () => { monthShowAll = true; renderMonthly(); };
  } else if (monthShowAll) {
    toggleRow.textContent = '▴ Hide empty past days';
    toggleRow.onclick = () => { monthShowAll = false; renderMonthly(); };
  } else {
    toggleRow.textContent = '';
    toggleRow.onclick = null;
  }
}

// ── Render: All Tasks ──────────────────────────────────────────────────────
function renderAllTasks() {
  const tasks = entries.filter(e => e.type === 'task');
  fill(document.getElementById('open-list'),     tasks.filter(e => e.status==='open'));
  fill(document.getElementById('migrated-list'), tasks.filter(e => e.status==='migrated'));
  fill(document.getElementById('done-list'),     tasks.filter(e => e.status==='completed'));
}

// ── render(tab) — only builds the active tab ───────────────────────────────
function render(tab) {
  switch(tab) {
    case 'daily':   return renderDaily();
    case 'weekly':  return renderWeekly();
    case 'monthly': return renderMonthly();
    case 'all':     return renderAllTasks();
  }
}
function renderAll() { ['daily','weekly','monthly','all'].forEach(render); }

// ── Drop zone ──────────────────────────────────────────────────────────────
function setupDropZone(el, getTargetDay) {
  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/plain') || draggedId;
    if (!id) return;
    const entry = entries.find(en => en.id === id);
    if (!entry) return;
    entry.day    = getTargetDay();
    entry.type   = 'task';
    entry.status = entry.status === 'completed' ? 'completed' : 'open';
    save(); renderAll();
  });
}

// ── Live symbol preview in main add forms ──────────────────────────────────
[['daily-input','daily-sym'], ['week-input','week-sym'], ['month-input','month-sym']].forEach(([inpId, symId]) => {
  const inp = document.getElementById(inpId);
  const sym = document.getElementById(symId);
  inp.addEventListener('input', () => {
    sym.textContent = previewSym(inp.value);
    sym.style.color = /^!\s/.test(inp.value.trim()) ? '#c0392b' : '#ccc';
  });
});

// ── Add form handlers ──────────────────────────────────────────────────────
function handleAdd(inputId, dayFn) {
  return e => {
    e.preventDefault();
    const inp = document.getElementById(inputId);
    const raw = inp.value.trim(); if (!raw) return;
    const { type, priority, text } = parseInput(raw);
    entries.push({ id: Date.now().toString(), type, text, status:'open', priority, day: dayFn() });
    save(); render(activeTab); inp.value = '';
    document.getElementById(inputId.replace('input','sym')).textContent = '•';
    document.getElementById(inputId.replace('input','sym')).style.color = '';
    inp.focus();
  };
}
document.getElementById('daily-form').addEventListener('submit',
  handleAdd('daily-input', () => todayKey()));
document.getElementById('week-form').addEventListener('submit',
  handleAdd('week-input',  () => weekTaskKey(weekOffset)));
document.getElementById('month-form').addEventListener('submit',
  handleAdd('month-input', () => monthTaskKey(monthOffset)));

// ── Period navigation ──────────────────────────────────────────────────────
document.getElementById('week-prev').addEventListener('click',  () => { weekOffset--;  renderWeekly(); });
document.getElementById('week-next').addEventListener('click',  () => { weekOffset++;  renderWeekly(); });
document.getElementById('month-prev').addEventListener('click', () => { monthOffset--; renderMonthly(); });
document.getElementById('month-next').addEventListener('click', () => { monthOffset++; renderMonthly(); });

// ── Tab switching ──────────────────────────────────────────────────────────
const TAB_IDS   = { daily:'tab-daily', weekly:'tab-weekly', monthly:'tab-monthly', all:'tab-all' };
const INPUT_IDS = { daily:'daily-input', weekly:'week-input', monthly:'month-input', all:null };

function switchTab(tab) {
  if (!TAB_IDS[tab]) return;
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  Object.entries(TAB_IDS).forEach(([k, id]) => {
    document.getElementById(id).style.display = (k === tab) ? '' : 'none';
  });
  render(tab);
  focusActiveInput();
}

function focusActiveInput() {
  const id = INPUT_IDS[activeTab];
  if (id) setTimeout(() => document.getElementById(id).focus(), 50);
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const inInput = e.target.matches('input, textarea, [contenteditable]');

  // Ctrl/Cmd+Z — undo delete (always active)
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault(); undoDelete(); return;
  }

  if (inInput) {
    if (e.key === 'Escape') { e.target.blur(); return; }
    return;
  }

  if      (e.key === '1') switchTab('daily');
  else if (e.key === '2') switchTab('weekly');
  else if (e.key === '3') switchTab('monthly');
  else if (e.key === '4') switchTab('all');
  else if (e.key === 'n' || e.key === 'a') { e.preventDefault(); focusActiveInput(); }
});

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('date-line').textContent = new Date().toLocaleDateString('en-US', {
  weekday:'long', year:'numeric', month:'long', day:'numeric'
});

renderAll();
setupDropZone(document.getElementById('month-tasks-list'), () => monthTaskKey(monthOffset));
