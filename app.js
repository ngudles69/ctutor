// ============================================
// SECTIONS PIPELINE
// ============================================
const SECTIONS = [
  {
    id: 'guided', name: 'Guided Trace', desc: 'Practice with stroke outlines',
    rounds: 3, showOutline: true, showRef: true,
    controls: ['restart', 'animate', 'skip'],
  },
  {
    id: 'free', name: 'Free Trace', desc: 'Write without outlines',
    rounds: 1, showOutline: false, showRef: true,
    controls: ['restart', 'guided', 'animate', 'skip'],
  },
  {
    id: 'tingxie', name: '\u542C\u5199', desc: 'Listen and write from memory',
    rounds: 1, showOutline: false, showRef: false,
    randomize: true, perCharScoring: true,
    controls: ['restart', 'skip'],
  },
];

const REVISION_SECTION = {
  id: 'revision', name: 'Revision', desc: 'Review wrong characters',
  rounds: 3, showOutline: true, showRef: true,
  controls: ['restart', 'animate', 'skip'],
};

// ============================================
// CONSTANTS
// ============================================
const TV_REWARDS = [30, 20, 10];
const MAX_PHRASES = 20;
const MAX_MISTAKES_UNGUIDED = 2;
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CEDICT_URL = 'https://cdn.jsdelivr.net/gh/krmanik/cedict-json/v2/';
const PHRASE_DELIM = /[,\uFF0C\s.\u3002\u3001;\uFF1B\n\r]+/;
const SECTION_SCORES = { guided: 20, free: 20, tingxie: 40, bonus: 20 };

// ============================================
// STORAGE LAYER
// ============================================
const Storage = {
  _data: null, _KEY: 'ctutor_data',
  _load() {
    if (this._data) return this._data;
    try {
      const raw = localStorage.getItem(this._KEY);
      this._data = raw ? JSON.parse(raw) : this._default();
      this._migrate();
    } catch (e) { this._data = this._default(); }
    return this._data;
  },
  _save() { try { localStorage.setItem(this._KEY, JSON.stringify(this._data)); } catch(e){} },
  _default() { return { pin: '1357', lessons: [] }; },
  _migrate() {
    this._data.lessons.forEach(l => {
      if (l.characters && !l.phrases) {
        l.phrases = l.characters.map(c => c);
        delete l.characters;
        this._save();
      }
    });
  },
  getPin() { return this._load().pin; },
  setPin(pin) { this._load().pin = pin; this._save(); },
  getLessons() { return this._load().lessons; },
  getLesson(id) { return this.getLessons().find(l => l.id === id); },
  createLesson(name, phrases) {
    const lesson = { id: 'l_' + Date.now(), name, phrases, createdAt: Date.now(), completions: [] };
    this._load().lessons.push(lesson); this._save(); return lesson;
  },
  updateLesson(id, name, phrases) {
    const l = this.getLesson(id); if (!l) return;
    l.name = name; l.phrases = phrases; this._save();
  },
  deleteLesson(id) { const d = this._load(); d.lessons = d.lessons.filter(l => l.id !== id); this._save(); },
  addCompletion(lessonId, comp) {
    const l = this.getLesson(lessonId); if (!l) return;
    comp.id = 'c_' + Date.now(); comp.date = Date.now();
    l.completions.push(comp); this._save(); return comp;
  },
  markClaimed(lessonId, compId, claimed) {
    const l = this.getLesson(lessonId); if (!l) return;
    const c = l.completions.find(x => x.id === compId);
    if (c) { c.claimed = claimed; this._save(); }
  },
  setCompletionNote(lessonId, compId, note) {
    const l = this.getLesson(lessonId); if (!l) return;
    const c = l.completions.find(x => x.id === compId);
    if (c) { c.note = note; this._save(); }
  },
  getUnclaimedBalance() {
    return this.getLessons().reduce((s, l) => s + l.completions.filter(c => !c.claimed).reduce((a, c) => a + c.tvEarned, 0), 0);
  },
  getTotalEarned() {
    return this.getLessons().reduce((s, l) => s + l.completions.reduce((a, c) => a + c.tvEarned, 0), 0);
  },
  getNextReward(lessonId) {
    const l = this.getLesson(lessonId); if (!l) return TV_REWARDS[TV_REWARDS.length - 1];
    return TV_REWARDS[Math.min(l.completions.length, TV_REWARDS.length - 1)];
  },
};

// ============================================
// STATE
// ============================================
const state = {
  mode: null, currentLessonId: null,
  // Practice
  phrases: [],
  activeSectionId: null,      // current section being practiced
  phraseOrder: [],             // indices into phrases[]
  phraseOrderIdx: 0,           // index into phraseOrder
  currentCharIdx: 0,           // char within current phrase
  roundNum: 1,
  guidedTotal: 3,
  isAnimating: false,
  charAttempts: 0,       // failed attempts on current char (for fail dialog)
  // Section menu scoring
  sectionScores: { guided: 0, free: 0, tingxie: 0, bonus: 0 },
  completedSections: [],       // array of completed section IDs (serializable)
  revisionPhrases: [],         // phrase indices wrong in tingxie
  tingxieResults: {},          // { phraseIdx: [bool, bool, ...] }
  tingxieCharResults: [],      // boolean per char for current phrase
  // Writers
  refWriter: null, quizWriter: null, phraseWriters: [],
  dictCache: {},
  // Edit
  editingLessonId: null,
  navStack: [],
};

// ============================================
// DOM
// ============================================
const $ = id => document.getElementById(id);
const els = {
  topBar:$('top-bar'), topTitle:$('top-title'), btnBack:$('btn-back'), btnModeSwitch:$('btn-mode-switch'),
  btnEnterLearner:$('btn-enter-learner'), btnEnterParent:$('btn-enter-parent'),
  btnExportData:$('btn-export-data'), btnImportData:$('btn-import-data'), importFileInput:$('import-file-input'),
  pinInput:$('pin-input'), pinError:$('pin-error'), btnPinSubmit:$('btn-pin-submit'), btnPinCancel:$('btn-pin-cancel'),
  balanceAmount:$('balance-amount'), lessonListLearner:$('lesson-list-learner'), noLessonsLearner:$('no-lessons-learner'),
  statLessons:$('stat-lessons'), statUnclaimed:$('stat-unclaimed'), statTotal:$('stat-total'),
  lessonListParent:$('lesson-list-parent'), noLessonsParent:$('no-lessons-parent'),
  btnAddLesson:$('btn-add-lesson'), btnChangePin:$('btn-change-pin'),
  lessonNameInput:$('lesson-name-input'), phraseInputsContainer:$('phrase-inputs-container'),
  btnAddPhrase:$('btn-add-phrase'),
  lessonPhraseCount:$('lesson-phrase-count'), lessonPhrasePreview:$('lesson-phrase-preview'),
  lessonError:$('lesson-error'), btnSaveLesson:$('btn-save-lesson'), btnCancelLesson:$('btn-cancel-lesson'),
  reviewName:$('review-name'), reviewPhrases:$('review-phrases'),
  reviewCompletions:$('review-completions'), noCompletions:$('no-completions'),
  btnEditLesson:$('btn-edit-lesson'), btnDeleteLesson:$('btn-delete-lesson'),
  currentPinInput:$('current-pin-input'), newPinInput:$('new-pin-input'), confirmPinInput:$('confirm-pin-input'),
  pinChangeError:$('pin-change-error'), btnSavePin:$('btn-save-pin'), btnCancelPin:$('btn-cancel-pin'),
  // Section menu
  sectionMenuScore:$('section-menu-score'), sectionMenuList:$('section-menu-list'),
  btnCompleteLesson:$('btn-complete-lesson'), confettiContainerMenu:$('confetti-container-menu'),
  // Practice
  sectionTabs:$('section-tabs'), phraseCharsDisplay:$('phrase-chars-display'),
  phraseProgress:$('phrase-progress'), practiceScore:$('practice-score'),
  refArea:$('ref-area'), tingxieArea:$('tingxie-area'), tingxieCharsDisplay:$('tingxie-chars-display'), btnSpeakPhrase:$('btn-speak-phrase'),
  refCharContainer:$('ref-char-container'), refWriterTarget:$('ref-writer-target'),
  refInfo:$('ref-info'), pinyinDisplay:$('pinyin-display'), meaningDisplay:$('meaning-display'),
  btnSpeak:$('btn-speak'), progressInfo:$('progress-info'),
  attemptDisplay:$('attempt-display'),
  quizWriterTarget:$('quiz-writer-target'), feedbackOverlay:$('feedback-overlay'),
  practiceControls:$('practice-controls'),
  btnRestart:$('btn-restart'), btnGuided:$('btn-guided'), btnAnimate:$('btn-animate'), btnSkip:$('btn-skip'),
  failDialog:$('fail-dialog'), btnRetryGuided:$('btn-retry-guided'), btnRetryFree:$('btn-retry-free'), btnFailSkip:$('btn-fail-skip'),
  successOverlay:$('success-overlay'),
  // Reward
  scoreSummary:$('score-summary'), tvTimeDisplay:$('tv-time-display'), tvTimeTotal:$('tv-time-total'),
  confettiContainer:$('confetti-container'), btnBackToLessons:$('btn-back-to-lessons'),
};

// ============================================
// INIT
// ============================================
function init() {
  els.btnEnterLearner.addEventListener('click', () => enterLearnerMode());
  els.btnEnterParent.addEventListener('click', () => showPinEntry('parent'));
  els.btnExportData.addEventListener('click', exportData);
  els.btnImportData.addEventListener('click', () => els.importFileInput.click());
  els.importFileInput.addEventListener('change', importData);
  els.btnBack.addEventListener('click', navBack);
  els.btnModeSwitch.addEventListener('click', handleModeSwitch);
  els.btnPinSubmit.addEventListener('click', submitPin);
  els.btnPinCancel.addEventListener('click', () => navigateTo('home'));
  els.pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });
  els.btnAddLesson.addEventListener('click', () => showCreateLesson());
  els.btnChangePin.addEventListener('click', () => navigateTo('change-pin', 'Change PIN'));
  els.lessonNameInput.addEventListener('input', validateLessonInput);
  els.btnAddPhrase.addEventListener('click', () => addPhraseInput(''));
  els.btnSaveLesson.addEventListener('click', saveLesson);
  els.btnCancelLesson.addEventListener('click', navBack);
  els.btnEditLesson.addEventListener('click', editCurrentLesson);
  els.btnDeleteLesson.addEventListener('click', deleteCurrentLesson);
  els.btnSavePin.addEventListener('click', saveNewPin);
  els.btnCancelPin.addEventListener('click', navBack);
  els.btnRestart.addEventListener('click', restartCurrentTrace);
  els.btnGuided.addEventListener('click', switchToGuided);
  els.btnAnimate.addEventListener('click', showAnimation);
  els.btnSkip.addEventListener('click', skipCharacter);
  els.btnSpeak.addEventListener('click', () => speakText(getCurrentPhrase()));
  els.btnSpeakPhrase.addEventListener('click', () => speakText(getCurrentPhrase()));
  els.btnRetryGuided.addEventListener('click', retryWithGuided);
  els.btnRetryFree.addEventListener('click', retryFree);
  els.btnFailSkip.addEventListener('click', () => { els.failDialog.classList.add('hidden'); skipCharacter(); });
  els.btnBackToLessons.addEventListener('click', () => navigateTo('learner', 'Lessons'));
  els.btnCompleteLesson.addEventListener('click', completeLesson);
  document.addEventListener('dblclick', e => e.preventDefault());
}
document.addEventListener('DOMContentLoaded', init);

// ============================================
// NAVIGATION
// ============================================
function navigateTo(screenId, title, opts) {
  opts = opts || {};
  document.querySelectorAll('.screen').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
  const showTop = screenId !== 'home';
  els.topBar.classList.toggle('hidden', !showTop);
  const target = $('screen-' + screenId);
  target.classList.remove('hidden'); target.classList.add('active');
  target.classList.toggle('has-topbar', showTop);
  if (showTop) {
    els.topTitle.textContent = title || '';
    els.btnBack.classList.toggle('invisible', ['learner','parent'].includes(screenId));
  }
  if (!opts.replace) state.navStack.push({ screenId, title });
  if (screenId === 'learner') renderLearnerDashboard();
  if (screenId === 'parent') renderParentDashboard();
  if (screenId === 'section-menu') renderSectionMenu();
}
function navBack() {
  if (state.navStack.length > 1) { state.navStack.pop(); const p = state.navStack[state.navStack.length-1]; navigateTo(p.screenId, p.title, {replace:true}); }
  else navigateTo('home');
}
function handleModeSwitch() { state.mode === 'learner' ? showPinEntry('parent') : enterLearnerMode(); }
function enterLearnerMode() { state.mode='learner'; state.navStack=[]; navigateTo('learner','Lessons'); }
function enterParentMode() { state.mode='parent'; state.navStack=[]; navigateTo('parent','Parent / Teacher'); }

// ============================================
// PIN
// ============================================
let pinTarget = null;
function showPinEntry(t) { pinTarget=t; els.pinInput.value=''; els.pinError.classList.add('hidden'); navigateTo('pin','Enter PIN'); setTimeout(()=>els.pinInput.focus(),100); }
function submitPin() {
  if (els.pinInput.value === Storage.getPin()) { els.pinError.classList.add('hidden'); if (pinTarget==='parent') enterParentMode(); }
  else { els.pinError.textContent='Incorrect PIN'; els.pinError.classList.remove('hidden'); els.pinInput.value=''; els.pinInput.focus(); }
}

// ============================================
// LEARNER DASHBOARD
// ============================================
function renderLearnerDashboard() {
  els.balanceAmount.textContent = Storage.getUnclaimedBalance() + ' min';
  const lessons = Storage.getLessons();
  els.lessonListLearner.innerHTML = '';
  els.noLessonsLearner.classList.toggle('hidden', lessons.length > 0);
  lessons.forEach(lesson => {
    const next = Storage.getNextReward(lesson.id);
    const card = document.createElement('div'); card.className = 'lesson-card';
    card.innerHTML =
      '<div class="lesson-card-header"><div class="lesson-card-name">' + esc(lesson.name) + '</div>' +
      '<span class="lesson-card-badge ' + (lesson.completions.length ? 'badge-done' : 'badge-new') + '">' +
      (lesson.completions.length ? 'Done x' + lesson.completions.length : 'New') + '</span></div>' +
      '<div class="phrase-preview">' + lesson.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('') + '</div>' +
      '<div class="lesson-card-reward">Complete for ' + next + ' min TV time</div>';
    card.addEventListener('click', () => startLesson(lesson.id));
    els.lessonListLearner.appendChild(card);
  });
}

// ============================================
// PARENT DASHBOARD
// ============================================
function renderParentDashboard() {
  const lessons = Storage.getLessons();
  els.statLessons.textContent = lessons.length;
  els.statUnclaimed.textContent = Storage.getUnclaimedBalance() + ' min';
  els.statTotal.textContent = Storage.getTotalEarned() + ' min';
  els.lessonListParent.innerHTML = '';
  els.noLessonsParent.classList.toggle('hidden', lessons.length > 0);
  lessons.forEach(lesson => {
    const unclaimed = lesson.completions.filter(c => !c.claimed).length;
    const card = document.createElement('div'); card.className = 'lesson-card';
    card.innerHTML =
      '<div class="lesson-card-header"><div class="lesson-card-name">' + esc(lesson.name) + '</div>' +
      (unclaimed ? '<span class="lesson-card-badge badge-new">' + unclaimed + ' unclaimed</span>' : '') + '</div>' +
      '<div class="phrase-preview">' + lesson.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('') + '</div>' +
      '<div class="lesson-card-stats"><span>Completed: ' + lesson.completions.length + ' times</span></div>';
    card.addEventListener('click', () => showLessonReview(lesson.id));
    els.lessonListParent.appendChild(card);
  });
}

// ============================================
// CREATE / EDIT LESSON (individual phrase inputs)
// ============================================
function parsePhrases(text) {
  return text.split(PHRASE_DELIM).map(s => {
    let p = ''; for (const ch of s) { if (CJK_REGEX.test(ch)) p += ch; }
    return p;
  }).filter(p => p.length > 0);
}

function extractCJK(text) {
  let p = ''; for (const ch of text) { if (CJK_REGEX.test(ch)) p += ch; }
  return p;
}

function addPhraseInput(value) {
  const count = els.phraseInputsContainer.querySelectorAll('.phrase-input-row').length;
  if (count >= MAX_PHRASES) return;
  const row = document.createElement('div');
  row.className = 'phrase-input-row';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'phrase-field';
  input.placeholder = 'Type a phrase'; input.lang = 'zh'; input.autocomplete = 'off';
  input.value = value || '';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn-remove-phrase'; btn.textContent = '\u00d7';
  btn.addEventListener('click', () => removePhraseInput(row));
  input.addEventListener('input', () => handlePhraseFieldInput(input));
  row.appendChild(input); row.appendChild(btn);
  els.phraseInputsContainer.appendChild(row);
  validateLessonInput();
  return input;
}

function removePhraseInput(row) {
  const rows = els.phraseInputsContainer.querySelectorAll('.phrase-input-row');
  if (rows.length <= 1) return;
  row.remove();
  validateLessonInput();
}

function handlePhraseFieldInput(input) {
  const val = input.value;
  // Check for delimiters — auto-split
  if (PHRASE_DELIM.test(val)) {
    const parts = parsePhrases(val);
    if (parts.length > 1) {
      input.value = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const newInput = addPhraseInput(parts[i]);
        if (!newInput) break; // MAX_PHRASES reached
      }
    } else if (parts.length === 1) {
      input.value = parts[0];
    } else {
      input.value = '';
    }
  }
  validateLessonInput();
}

function getPhraseFieldValues() {
  const fields = els.phraseInputsContainer.querySelectorAll('.phrase-field');
  const phrases = [];
  fields.forEach(f => {
    const cjk = extractCJK(f.value);
    if (cjk.length > 0) phrases.push(cjk);
  });
  return phrases;
}

function showCreateLesson(editId) {
  state.editingLessonId = editId || null;
  els.phraseInputsContainer.innerHTML = '';
  if (editId) {
    const l = Storage.getLesson(editId);
    els.lessonNameInput.value = l.name;
    l.phrases.forEach(p => addPhraseInput(p));
    navigateTo('create-lesson', 'Edit Lesson');
  } else {
    els.lessonNameInput.value = '';
    addPhraseInput('');
    navigateTo('create-lesson', 'New Lesson');
  }
  els.lessonError.classList.add('hidden');
  validateLessonInput();
}

function validateLessonInput() {
  const name = els.lessonNameInput.value.trim();
  const phrases = getPhraseFieldValues();
  els.lessonPhraseCount.textContent = phrases.length + ' / ' + MAX_PHRASES + ' phrases';
  els.lessonPhraseCount.style.color = (phrases.length >= 1 && phrases.length <= MAX_PHRASES) ? '#4CAF50' : '#888';
  els.lessonPhrasePreview.innerHTML = '';
  phrases.forEach(p => {
    const pill = document.createElement('span'); pill.className = 'phrase-pill'; pill.textContent = p;
    els.lessonPhrasePreview.appendChild(pill);
  });
  // Hide add button at max
  els.btnAddPhrase.style.display = (els.phraseInputsContainer.querySelectorAll('.phrase-input-row').length >= MAX_PHRASES) ? 'none' : '';
  els.btnSaveLesson.disabled = !(name.length > 0 && phrases.length >= 1 && phrases.length <= MAX_PHRASES);
}

function saveLesson() {
  const name = els.lessonNameInput.value.trim();
  const phrases = getPhraseFieldValues();
  if (!name || phrases.length < 1 || phrases.length > MAX_PHRASES) return;
  if (state.editingLessonId) Storage.updateLesson(state.editingLessonId, name, phrases);
  else Storage.createLesson(name, phrases);
  state.editingLessonId = null; navBack();
}

// ============================================
// LESSON REVIEW
// ============================================
function showLessonReview(lessonId) {
  state.currentLessonId = lessonId;
  navigateTo('lesson-review', 'Lesson Review');
  renderLessonReview();
}
function renderLessonReview() {
  const l = Storage.getLesson(state.currentLessonId); if (!l) return;
  els.reviewName.textContent = l.name;
  els.reviewPhrases.innerHTML = l.phrases.map(p => '<span class="phrase-pill">' + esc(p) + '</span>').join('');
  els.reviewCompletions.innerHTML = '';
  els.noCompletions.classList.toggle('hidden', l.completions.length > 0);
  l.completions.forEach((comp) => {
    const d = new Date(comp.date);
    const item = document.createElement('div');
    item.className = 'completion-item' + (comp.claimed ? ' claimed' : '');
    item.innerHTML =
      '<div class="completion-row">' +
      '<div class="completion-info"><div class="completion-date">' + d.toLocaleDateString() + '</div>' +
      '<div class="completion-detail">Score: ' + (comp.score||0) + '/100 &middot; ' + comp.tvEarned + ' min TV</div></div>' +
      '<div class="completion-reward"><span class="reward-amount">' + comp.tvEarned + ' min</span>' +
      '<input type="checkbox" class="claim-checkbox" ' + (comp.claimed ? 'checked' : '') + '></div>' +
      '</div>' +
      '<input type="text" class="completion-note-input" placeholder="Add a note...">';
    const noteInput = item.querySelector('.completion-note-input');
    noteInput.value = comp.note || '';
    noteInput.addEventListener('input', function() {
      Storage.setCompletionNote(state.currentLessonId, comp.id, this.value);
    });
    item.querySelector('.claim-checkbox').addEventListener('change', function() {
      Storage.markClaimed(state.currentLessonId, comp.id, this.checked);
      renderLessonReview();
    });
    els.reviewCompletions.appendChild(item);
  });
}
function editCurrentLesson() { showCreateLesson(state.currentLessonId); }
function deleteCurrentLesson() { if(confirm('Delete this lesson?')){ Storage.deleteLesson(state.currentLessonId); navBack(); } }

// ============================================
// CHANGE PIN
// ============================================
function saveNewPin() {
  const cur=els.currentPinInput.value, np=els.newPinInput.value, cf=els.confirmPinInput.value, e=els.pinChangeError;
  if (cur!==Storage.getPin()) { e.textContent='Current PIN is incorrect'; e.classList.remove('hidden'); return; }
  if (!/^\d{4}$/.test(np)) { e.textContent='New PIN must be 4 digits'; e.classList.remove('hidden'); return; }
  if (np!==cf) { e.textContent='PINs do not match'; e.classList.remove('hidden'); return; }
  Storage.setPin(np); els.currentPinInput.value=''; els.newPinInput.value=''; els.confirmPinInput.value='';
  e.classList.add('hidden'); navBack();
}

// ============================================
// EXPORT / IMPORT
// ============================================
function exportData() {
  const data = { lessons: Storage.getLessons(), exportedAt: Date.now(), version: 1 };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  a.href = url;
  a.download = 'ctutor-backup-' + date + '.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.lessons)) {
        alert('Invalid backup file: missing lessons array');
        return;
      }
      if (!confirm('This will replace all existing lessons and progress. Continue?')) {
        return;
      }
      // Replace lessons but preserve PIN
      const cur = Storage._load();
      cur.lessons = data.lessons;
      Storage._save();
      alert('Imported ' + data.lessons.length + ' lesson(s).');
      // Refresh current screen if applicable
      if (state.mode === 'learner') renderLearnerDashboard();
      if (state.mode === 'parent') renderParentDashboard();
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = ''; // reset so same file can be re-imported
}

// ============================================
// SECTION MENU
// ============================================
function computeSectionStatus() {
  const s = {};
  const done = id => state.completedSections.includes(id);
  s.guided = done('guided') ? 'done' : 'unlocked';
  s.free = done('guided') ? (done('free') ? 'done' : 'unlocked') : 'locked';
  s.tingxie = done('free') ? (done('tingxie') ? 'done' : 'unlocked') : 'locked';
  // Revision only if tingxie done AND there were errors
  if (done('tingxie') && state.revisionPhrases.length > 0) {
    s.revision = done('revision') ? 'done' : 'unlocked';
  }
  return s;
}

function canCompleteLesson() {
  const s = computeSectionStatus();
  const base = s.guided === 'done' && s.free === 'done' && s.tingxie === 'done';
  const rev = !s.revision || s.revision === 'done';
  return base && rev;
}

function calcTotalScore() {
  return state.sectionScores.guided + state.sectionScores.free + state.sectionScores.tingxie + state.sectionScores.bonus;
}

function renderSectionMenu() {
  const status = computeSectionStatus();
  els.sectionMenuScore.textContent = calcTotalScore() + ' / 100';

  els.sectionMenuList.innerHTML = '';
  const sections = SECTIONS.slice();
  if (status.revision) sections.push(REVISION_SECTION);

  sections.forEach(sec => {
    const st = status[sec.id] || 'locked';
    const card = document.createElement('div');
    card.className = 'section-menu-card ' + st;
    card.dataset.section = sec.id;

    let icon = '\uD83D\uDD12'; // lock
    if (st === 'unlocked') icon = '\u25B6'; // play
    if (st === 'done') icon = '\u2714'; // checkmark

    let pts = '\u2014';
    if (sec.id === 'revision') {
      pts = state.revisionPhrases.length + ' phrases';
    } else if (st === 'done') {
      pts = state.sectionScores[sec.id] + ' pts';
    } else {
      pts = SECTION_SCORES[sec.id] + ' pts';
    }

    card.innerHTML =
      '<div class="section-menu-icon">' + icon + '</div>' +
      '<div class="section-menu-info"><div class="section-menu-name">' + esc(sec.name) + '</div>' +
      '<div class="section-menu-desc">' + esc(sec.desc) + '</div></div>' +
      '<div class="section-menu-points">' + pts + '</div>';

    if (st !== 'locked') {
      card.addEventListener('click', () => enterSection(sec.id));
    }
    els.sectionMenuList.appendChild(card);
  });

  els.btnCompleteLesson.disabled = !canCompleteLesson();
}

// ============================================
// PRACTICE - SECTION PIPELINE
// ============================================
function getActiveSection() {
  if (state.activeSectionId === 'revision') return REVISION_SECTION;
  return SECTIONS.find(s => s.id === state.activeSectionId);
}
function getCurrentPhrase() { return state.phrases[state.phraseOrder[state.phraseOrderIdx]]; }
function getCurrentChar() { return getCurrentPhrase()[state.currentCharIdx]; }
function getCurrentPhraseIdx() { return state.phraseOrder[state.phraseOrderIdx]; }

async function startLesson(lessonId) {
  const lesson = Storage.getLesson(lessonId); if (!lesson) return;
  state.currentLessonId = lessonId;
  state.phrases = lesson.phrases.slice();
  state.sectionScores = { guided: 0, free: 0, tingxie: 0, bonus: 0 };
  state.completedSections = [];
  state.revisionPhrases = [];
  state.tingxieResults = {};
  state.activeSectionId = null;

  // Fetch dict data for all unique characters
  const allChars = [...new Set(state.phrases.join('').split(''))].filter(c => CJK_REGEX.test(c));
  await fetchDictData(allChars);

  const lesson2 = Storage.getLesson(lessonId);
  navigateTo('section-menu', lesson2.name);
}

function enterSection(sectionId) {
  state.activeSectionId = sectionId;
  const sec = getActiveSection();

  // Build phrase order
  if (sectionId === 'revision') {
    state.phraseOrder = state.revisionPhrases.slice();
  } else {
    state.phraseOrder = state.phrases.map((_, i) => i);
    if (sec.randomize) {
      for (let i = state.phraseOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.phraseOrder[i], state.phraseOrder[j]] = [state.phraseOrder[j], state.phraseOrder[i]];
      }
    }
  }
  state.phraseOrderIdx = 0;

  // Reset tingxie tracking for this run
  if (sectionId === 'tingxie') {
    state.tingxieResults = {};
  }

  const lesson = Storage.getLesson(state.currentLessonId);
  navigateTo('practice', lesson.name);
  renderSectionLabel();
  updateControls();
  startPhrase();
}

function renderSectionLabel() {
  const sec = getActiveSection();
  els.sectionTabs.innerHTML = '<div class="section-tab-label">' + esc(sec.name) + '</div>';
}

function exitSection() {
  const sectionId = state.activeSectionId;

  // Mark completed (if not already)
  if (!state.completedSections.includes(sectionId)) {
    state.completedSections.push(sectionId);
  }

  // Award score (one-time)
  if (sectionId === 'tingxie') {
    collectRevisionPhrases();
    if (state.revisionPhrases.length === 0) {
      // Perfect tingxie — award 40 pts
      if (state.sectionScores.tingxie === 0) state.sectionScores.tingxie = SECTION_SCORES.tingxie;
    }
    // else: 40 pts held until revision done
  } else if (sectionId === 'revision') {
    // Revision complete — award tingxie points
    if (state.sectionScores.tingxie === 0) state.sectionScores.tingxie = SECTION_SCORES.tingxie;
  } else {
    if (state.sectionScores[sectionId] === 0) {
      state.sectionScores[sectionId] = SECTION_SCORES[sectionId];
    }
  }

  destroyWriters();

  // Show confetti on section menu, then navigate
  const lesson = Storage.getLesson(state.currentLessonId);
  navigateTo('section-menu', lesson.name, {replace: true});
  // Remove practice from nav stack
  state.navStack = state.navStack.filter(n => n.screenId !== 'practice');
  launchConfetti(els.confettiContainerMenu);
}

function collectRevisionPhrases() {
  // Only collect on first tingxie completion
  if (state.completedSections.filter(id => id === 'tingxie').length > 1) return;
  state.revisionPhrases = [];
  for (const piStr in state.tingxieResults) {
    const pi = parseInt(piStr);
    const results = state.tingxieResults[pi];
    if (results && results.some(r => !r)) {
      state.revisionPhrases.push(pi);
    }
  }
}

function completeLesson() {
  if (!canCompleteLesson()) return;
  state.sectionScores.bonus = SECTION_SCORES.bonus;
  showResults();
}

function startPhrase() {
  state.currentCharIdx = 0;
  state.roundNum = 1;
  state.guidedTotal = getActiveSection().rounds || 1;
  state.tingxieCharResults = [];
  state.isAnimating = false;

  destroyWriters();
  renderPhraseWriters();
  renderTingxieBoxes();
  updatePracticeUI();
  startCharacter();
}

function renderPhraseWriters() {
  const sec = getActiveSection();
  const phrase = getCurrentPhrase();

  state.phraseWriters = [];
  els.phraseCharsDisplay.innerHTML = '';

  if (!sec.showRef) return;

  for (let i = 0; i < phrase.length; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'phrase-char-hw' + (i === state.currentCharIdx ? ' active' : '');
    wrapper.dataset.idx = i;
    els.phraseCharsDisplay.appendChild(wrapper);

    const writer = HanziWriter.create(wrapper, phrase[i], {
      width: 36, height: 36, padding: 2,
      strokeColor: '#333', outlineColor: '#ddd',
    });
    writer.showCharacter();
    writer.showOutline();
    state.phraseWriters.push(writer);
  }
}

function updatePhraseHighlight() {
  const wrappers = els.phraseCharsDisplay.querySelectorAll('.phrase-char-hw');
  wrappers.forEach((w, i) => {
    w.classList.toggle('active', i === state.currentCharIdx);
  });
}

function renderTingxieBoxes() {
  els.tingxieCharsDisplay.innerHTML = '';
  const sec = getActiveSection();
  if (!sec.perCharScoring) return;

  const phrase = getCurrentPhrase();
  for (let i = 0; i < phrase.length; i++) {
    const box = document.createElement('div');
    box.className = 'tingxie-char-box' + (i === state.currentCharIdx ? ' active' : '');
    box.dataset.idx = i;
    els.tingxieCharsDisplay.appendChild(box);
  }
}

function updateTingxieHighlight() {
  const boxes = els.tingxieCharsDisplay.querySelectorAll('.tingxie-char-box');
  boxes.forEach((b, i) => {
    if (!b.classList.contains('completed')) {
      b.classList.toggle('active', i === state.currentCharIdx);
    }
  });
}

function revealTingxieChar(charIdx) {
  const boxes = els.tingxieCharsDisplay.querySelectorAll('.tingxie-char-box');
  const box = boxes[charIdx];
  if (!box || box.classList.contains('completed')) return;
  box.classList.remove('active');
  box.classList.add('completed');
  const char = getCurrentPhrase()[charIdx];
  const writer = HanziWriter.create(box, char, {
    width: 40, height: 40, padding: 2,
    strokeColor: '#2c3e50', outlineColor: '#ddd',
  });
  writer.showCharacter();
  writer.showOutline();
}

function startCharacter() {
  const sec = getActiveSection();
  const char = getCurrentChar();
  state.charAttempts = 0;

  updatePracticeUI();
  updateCharDetails();

  // Auto-speak the full phrase whenever a new character is shown
  speakText(getCurrentPhrase());

  // Reference area
  if (sec.showRef) {
    els.refArea.classList.remove('hidden');
    els.tingxieArea.classList.add('hidden');
    if (state.refWriter) state.refWriter.setCharacter(char);
    else state.refWriter = HanziWriter.create(els.refWriterTarget, char, {
      width: 80, height: 80, padding: 5, strokeColor: '#333', outlineColor: '#ccc',
      strokeAnimationSpeed: 1, delayBetweenStrokes: 300,
    });
  } else {
    els.refArea.classList.add('hidden');
    els.tingxieArea.classList.remove('hidden');
    updateTingxieHighlight();
  }

  // Quiz writer
  createQuizWriter(char, sec.showOutline && state.roundNum <= state.guidedTotal);
}

function createQuizWriter(char, showOutline) {
  els.quizWriterTarget.innerHTML = '';
  const container = $('practice-bottom');
  const size = Math.min(container.clientWidth - 20, container.clientHeight - 20, 320);

  state.quizWriter = HanziWriter.create(els.quizWriterTarget, char, {
    width: size, height: size, padding: 15,
    strokeColor: '#555', outlineColor: '#ddd',
    drawingColor: '#4CAF50', drawingWidth: 8,
    showOutline: showOutline, showCharacter: false,
    highlightColor: '#aaf',
    showHintAfterMisses: showOutline ? 3 : false,
    highlightOnComplete: false,
    leniency: 2,
  });

  state.quizWriter.quiz({
    onCorrectStroke: onCorrectStroke,
    onMistake: onMistake,
    onComplete: onCharComplete,
  });
}

// ============================================
// QUIZ CALLBACKS
// ============================================
function onCorrectStroke() { flashFeedback('green'); }
function onMistake() {
  flashFeedback('red');
  els.quizWriterTarget.classList.add('shake');
  setTimeout(() => els.quizWriterTarget.classList.remove('shake'), 400);
}

function onCharComplete(data) {
  if (state.isAnimating) return;
  state.isAnimating = true;
  const sec = getActiveSection();
  const isGuided = sec.showOutline && state.roundNum <= state.guidedTotal;

  // For tingxie, track per-char results and reveal the character box
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = (data.totalMistakes <= MAX_MISTAKES_UNGUIDED);
    revealTingxieChar(state.currentCharIdx);
  }

  // Free trace: show fail dialog if too many mistakes (auto-skip after 3 fails)
  if (!isGuided && !sec.perCharScoring && data.totalMistakes > MAX_MISTAKES_UNGUIDED) {
    state.charAttempts++;
    if (state.charAttempts >= 3) {
      // Auto-skip after 3 failed attempts
      state.isAnimating = false;
      state.charAttempts = 0;
      advanceAfterChar();
      return;
    }
    state.isAnimating = false;
    els.failDialog.classList.remove('hidden');
    return;
  }

  state.charAttempts = 0;
  showSuccessFlash(sec.perCharScoring ? '' : 'Nice!', () => {
    state.isAnimating = false;
    advanceAfterChar();
  });
}

function advanceAfterChar() {
  const phrase = getCurrentPhrase();
  if (state.currentCharIdx < phrase.length - 1) {
    state.currentCharIdx++;
    startCharacter();
  } else {
    onRoundComplete();
  }
}

function onRoundComplete() {
  const sec = getActiveSection();

  // Store tingxie results for this phrase
  if (sec.perCharScoring) {
    state.tingxieResults[getCurrentPhraseIdx()] = state.tingxieCharResults.slice();
  }

  if (sec.id === 'guided' || sec.id === 'revision') {
    if (state.roundNum < state.guidedTotal) {
      state.roundNum++;
      state.currentCharIdx = 0;
      destroyWriters();
      startCharacter();
    } else {
      advancePhrase();
    }
  } else {
    advancePhrase();
  }
}

function advancePhrase() {
  if (state.phraseOrderIdx < state.phraseOrder.length - 1) {
    state.phraseOrderIdx++;
    destroyWriters();
    startPhrase();
  } else {
    // Section complete
    exitSection();
  }
}

// ============================================
// SKIP
// ============================================
function skipCharacter() {
  if (state.isAnimating) return;
  const sec = getActiveSection();
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = false;
    revealTingxieChar(state.currentCharIdx);
  }
  advanceAfterChar();
}

// ============================================
// CONTROLS
// ============================================
function updateControls() {
  const sec = getActiveSection();
  const ctrls = sec.controls || [];
  els.btnRestart.classList.toggle('hidden', !ctrls.includes('restart'));
  els.btnGuided.classList.toggle('hidden', !ctrls.includes('guided'));
  els.btnAnimate.classList.toggle('hidden', !ctrls.includes('animate'));
  els.btnSkip.classList.toggle('hidden', !ctrls.includes('skip'));
}

function switchToGuided() {
  if (state.isAnimating) return;
  state.guidedTotal++;
  state.roundNum = state.guidedTotal;
  createQuizWriter(getCurrentChar(), true);
  updatePracticeUI();
}

function retryWithGuided() {
  els.failDialog.classList.add('hidden');
  state.guidedTotal++;
  state.roundNum = state.guidedTotal;
  createQuizWriter(getCurrentChar(), true);
  updatePracticeUI();
}

function retryFree() {
  els.failDialog.classList.add('hidden');
  createQuizWriter(getCurrentChar(), false);
}

function restartCurrentTrace() {
  if (state.isAnimating) return;
  const sec = getActiveSection();
  const isGuided = sec.showOutline && state.roundNum <= state.guidedTotal;
  createQuizWriter(getCurrentChar(), isGuided);
}

function showAnimation() {
  if (state.isAnimating || !state.refWriter) return;
  state.isAnimating = true;
  state.refWriter.animateCharacter({ onComplete: () => { state.isAnimating = false; } });
}

// ============================================
// UI UPDATES
// ============================================
function updatePracticeUI() {
  const sec = getActiveSection();

  // Phrase bar
  els.phraseProgress.textContent = 'Phrase ' + (state.phraseOrderIdx + 1) + '/' + state.phraseOrder.length;
  els.practiceScore.textContent = sec.name;

  updatePhraseHighlight();

  // Progress info
  if (sec.id === 'guided' || sec.id === 'revision') {
    els.attemptDisplay.textContent = 'Round ' + state.roundNum + '/' + state.guidedTotal;
  } else if (sec.id === 'free') {
    const isGuided = state.roundNum <= state.guidedTotal && state.guidedTotal > 1;
    els.attemptDisplay.textContent = isGuided ? 'Guided ' + state.roundNum + '/' + state.guidedTotal : 'Free Trace';
  } else {
    els.attemptDisplay.textContent = '';
  }

  if (sec.id === 'free') {
    els.btnGuided.classList.remove('hidden');
  }
}

// ============================================
// RESULTS & REWARD
// ============================================
function showResults() {
  const total = calcTotalScore();
  const lesson = Storage.getLesson(state.currentLessonId);
  const cycle = lesson.completions.length;
  const tvEarned = TV_REWARDS[Math.min(cycle, TV_REWARDS.length - 1)];

  Storage.addCompletion(state.currentLessonId, {
    cycle: cycle + 1, score: total, maxScore: 100,
    tvEarned: tvEarned, claimed: false,
  });

  const balance = Storage.getUnclaimedBalance();
  els.scoreSummary.innerHTML =
    '<div class="score-big">' + total + ' / 100</div>' +
    '<div>Guided: ' + state.sectionScores.guided + ' \u00b7 Free: ' + state.sectionScores.free +
    ' \u00b7 \u542C\u5199: ' + state.sectionScores.tingxie + ' \u00b7 Bonus: ' + state.sectionScores.bonus + '</div>';
  els.tvTimeDisplay.textContent = 'You earned ' + tvEarned + ' minutes!';
  els.tvTimeTotal.textContent = 'Balance: ' + balance + ' minutes';

  destroyWriters();
  navigateTo('reward', 'Lesson Complete!');
  launchConfetti(els.confettiContainer);
}

// ============================================
// DICTIONARY & PINYIN
// ============================================
function numPinyinToTone(s) {
  const tones = { a:'\u0101\u00e1\u01ce\u00e0a', e:'\u0113\u00e9\u011b\u00e8e', i:'\u012b\u00ed\u01d0\u00eci', o:'\u014d\u00f3\u01d2\u00f2o', u:'\u016b\u00fa\u01d4\u00f9u', v:'\u01d6\u01d8\u01da\u01dc\u00fc' };
  const m = s.match(/^([a-z\u00fc]+)(\d)$/i); if (!m) return s;
  let syl = m[1].toLowerCase().replace(/\u00fc/g,'v');
  const tone = parseInt(m[2]); if (tone<1||tone>5) return s;
  let idx = -1;
  if (syl.includes('a')) idx=syl.indexOf('a');
  else if (syl.includes('e')) idx=syl.indexOf('e');
  else if (syl.includes('ou')) idx=syl.indexOf('o');
  else { for(let i=syl.length-1;i>=0;i--){ if('aeiouv'.includes(syl[i])){idx=i;break;} } }
  if (idx===-1) return syl;
  return syl.substring(0,idx) + tones[syl[idx]][tone-1] + syl.substring(idx+1);
}

async function fetchDictData(chars) {
  await Promise.all(chars.map(async ch => {
    if (state.dictCache[ch]) return;
    try {
      const r = await fetch(CEDICT_URL + encodeURIComponent(ch) + '.json');
      if (!r.ok) throw 0; const d = await r.json();
      const py = (d.pinyin||[])[0]; const def = Object.values(d.definitions||{})[0]||'';
      state.dictCache[ch] = { pinyin: py ? numPinyinToTone(py) : '\u2014', meaning: def.split(/;\s*/).filter(Boolean).slice(0,2).join('; ') };
    } catch(e) { state.dictCache[ch] = { pinyin:'\u2014', meaning:'\u2014' }; }
  }));
}

function updateCharDetails() {
  const sec = getActiveSection();
  if (!sec.showRef) return;
  const ch = getCurrentChar();
  const info = state.dictCache[ch] || { pinyin:'', meaning:'' };
  els.pinyinDisplay.textContent = info.pinyin;
  els.meaningDisplay.textContent = info.meaning;
}

// ============================================
// SPEECH
// ============================================
let voicesReady = false;
function ensureVoices() {
  return new Promise(r => {
    if (speechSynthesis.getVoices().length) { voicesReady=true; r(); return; }
    speechSynthesis.addEventListener('voiceschanged', () => { voicesReady=true; r(); }, {once:true});
  });
}
async function speakText(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  if (!voicesReady) await ensureVoices();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 0.8;
  const v = speechSynthesis.getVoices().find(v => v.lang.startsWith('zh'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ============================================
// UTILITIES
// ============================================
function destroyWriters() {
  if (state.refWriter) { els.refWriterTarget.innerHTML=''; state.refWriter=null; }
  els.quizWriterTarget.innerHTML=''; state.quizWriter=null;
  state.phraseWriters = [];
}
function flashFeedback(color) {
  const o=els.feedbackOverlay; o.classList.remove('hidden','flash-red','flash-green');
  void o.offsetWidth; o.classList.add('flash-'+color);
  setTimeout(()=>{o.classList.add('hidden');o.classList.remove('flash-red','flash-green');},400);
}
function showSuccessFlash(text, cb) {
  if (!text) { if(cb) cb(); return; }
  const o=els.successOverlay; o.querySelector('.overlay-text').textContent=text;
  o.classList.remove('hidden'); setTimeout(()=>{o.classList.add('hidden');if(cb)cb();},800);
}
function launchConfetti(container) {
  container = container || els.confettiContainer;
  container.innerHTML='';
  const colors=['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff8cc8','#a855f7'];
  for(let i=0;i<50;i++){const p=document.createElement('div');p.className='confetti-piece';
  p.style.setProperty('--x',Math.random()*100+'vw');p.style.setProperty('--delay',Math.random()*.8+'s');
  p.style.setProperty('--color',colors[i%colors.length]);p.style.setProperty('--drift',(Math.random()-.5)*200+'px');
  container.appendChild(p);} setTimeout(()=>{container.innerHTML='';},4000);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
