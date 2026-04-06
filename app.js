// ============================================
// SECTIONS PIPELINE (extensible)
// ============================================
const SECTIONS = [
  {
    id: 'guided', name: 'Guided Trace', maxPoints: 3,
    rounds: 3, showOutline: true, showRef: true,
    controls: ['restart', 'animate', 'skip'],
  },
  {
    id: 'free', name: 'Free Trace', maxPoints: 2,
    rounds: 1, showOutline: false, showRef: true,
    controls: ['restart', 'guided', 'animate', 'skip'],
  },
  {
    id: 'tingxie', name: '听写', maxPoints: 5,
    rounds: 1, showOutline: false, showRef: false,
    randomize: true, perCharScoring: true,
    controls: ['restart', 'skip'],
  },
  // Future sections go here
];

// ============================================
// CONSTANTS
// ============================================
const TV_REWARDS = [30, 20, 10];
const MAX_PHRASES = 20;
const MAX_MISTAKES_UNGUIDED = 2;
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const CEDICT_URL = 'https://cdn.jsdelivr.net/gh/krmanik/cedict-json/v2/';
const PHRASE_DELIM = /[,，\s.。、;；\n\r]+/;

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
    // Migrate old character-based lessons to phrase-based
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
  sectionIdx: 0,
  phraseOrder: [],       // indices into phrases[]
  phraseOrderIdx: 0,     // index into phraseOrder
  currentCharIdx: 0,     // char within current phrase
  roundNum: 1,           // current round (1-based)
  guidedTotal: 3,        // total guided rounds (can increment)
  isAnimating: false,
  // Scoring: scores[phraseIdx][sectionId] = points
  scores: {},
  // Tingxie per-phrase tracking
  tingxieCharResults: [],  // boolean per char: true=correct
  // Writers
  refWriter: null, quizWriter: null,
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
  pinInput:$('pin-input'), pinError:$('pin-error'), btnPinSubmit:$('btn-pin-submit'), btnPinCancel:$('btn-pin-cancel'),
  balanceAmount:$('balance-amount'), lessonListLearner:$('lesson-list-learner'), noLessonsLearner:$('no-lessons-learner'),
  statLessons:$('stat-lessons'), statUnclaimed:$('stat-unclaimed'), statTotal:$('stat-total'),
  lessonListParent:$('lesson-list-parent'), noLessonsParent:$('no-lessons-parent'),
  btnAddLesson:$('btn-add-lesson'), btnChangePin:$('btn-change-pin'),
  lessonNameInput:$('lesson-name-input'), lessonPhrasesInput:$('lesson-phrases-input'),
  lessonPhraseCount:$('lesson-phrase-count'), lessonPhrasePreview:$('lesson-phrase-preview'),
  lessonError:$('lesson-error'), btnSaveLesson:$('btn-save-lesson'), btnCancelLesson:$('btn-cancel-lesson'),
  reviewName:$('review-name'), reviewPhrases:$('review-phrases'),
  reviewCompletions:$('review-completions'), noCompletions:$('no-completions'),
  btnEditLesson:$('btn-edit-lesson'), btnDeleteLesson:$('btn-delete-lesson'),
  currentPinInput:$('current-pin-input'), newPinInput:$('new-pin-input'), confirmPinInput:$('confirm-pin-input'),
  pinChangeError:$('pin-change-error'), btnSavePin:$('btn-save-pin'), btnCancelPin:$('btn-cancel-pin'),
  // Practice
  sectionTabs:$('section-tabs'), phraseCharsDisplay:$('phrase-chars-display'),
  phraseProgress:$('phrase-progress'), practiceScore:$('practice-score'),
  refArea:$('ref-area'), tingxieArea:$('tingxie-area'), btnSpeakPhrase:$('btn-speak-phrase'),
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
  els.btnBack.addEventListener('click', navBack);
  els.btnModeSwitch.addEventListener('click', handleModeSwitch);
  els.btnPinSubmit.addEventListener('click', submitPin);
  els.btnPinCancel.addEventListener('click', () => navigateTo('home'));
  els.pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });
  els.btnAddLesson.addEventListener('click', () => showCreateLesson());
  els.btnChangePin.addEventListener('click', () => navigateTo('change-pin', 'Change PIN'));
  els.lessonPhrasesInput.addEventListener('input', validateLessonInput);
  els.lessonNameInput.addEventListener('input', validateLessonInput);
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
  els.btnSpeak.addEventListener('click', () => speakText(getCurrentChar()));
  els.btnSpeakPhrase.addEventListener('click', () => speakText(getCurrentPhrase()));
  els.btnRetryGuided.addEventListener('click', retryWithGuided);
  els.btnRetryFree.addEventListener('click', retryFree);
  els.btnFailSkip.addEventListener('click', () => { els.failDialog.classList.add('hidden'); skipCharacter(); });
  els.btnBackToLessons.addEventListener('click', () => navigateTo('learner', 'Lessons'));
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
// CREATE / EDIT LESSON
// ============================================
function parsePhrases(text) {
  return text.split(PHRASE_DELIM).map(s => {
    let p = ''; for (const ch of s) { if (CJK_REGEX.test(ch)) p += ch; }
    return p;
  }).filter(p => p.length > 0);
}

function showCreateLesson(editId) {
  state.editingLessonId = editId || null;
  if (editId) {
    const l = Storage.getLesson(editId);
    els.lessonNameInput.value = l.name;
    els.lessonPhrasesInput.value = l.phrases.join(' ');
    navigateTo('create-lesson', 'Edit Lesson');
  } else {
    els.lessonNameInput.value = ''; els.lessonPhrasesInput.value = '';
    navigateTo('create-lesson', 'New Lesson');
  }
  els.lessonError.classList.add('hidden');
  validateLessonInput();
}

function validateLessonInput() {
  const name = els.lessonNameInput.value.trim();
  const phrases = parsePhrases(els.lessonPhrasesInput.value);
  els.lessonPhraseCount.textContent = phrases.length + ' / ' + MAX_PHRASES + ' phrases';
  els.lessonPhraseCount.style.color = (phrases.length >= 1 && phrases.length <= MAX_PHRASES) ? '#4CAF50' : '#888';
  els.lessonPhrasePreview.innerHTML = '';
  phrases.forEach(p => {
    const pill = document.createElement('span'); pill.className = 'phrase-pill'; pill.textContent = p;
    els.lessonPhrasePreview.appendChild(pill);
  });
  els.btnSaveLesson.disabled = !(name.length > 0 && phrases.length >= 1 && phrases.length <= MAX_PHRASES);
}

function saveLesson() {
  const name = els.lessonNameInput.value.trim();
  const phrases = parsePhrases(els.lessonPhrasesInput.value);
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
  l.completions.forEach((comp, i) => {
    const d = new Date(comp.date);
    const item = document.createElement('div');
    item.className = 'completion-item' + (comp.claimed ? ' claimed' : '');
    item.innerHTML =
      '<div class="completion-info"><div class="completion-date">' + d.toLocaleDateString() + '</div>' +
      '<div class="completion-detail">Score: ' + (comp.score||0) + ' &middot; ' + comp.tvEarned + ' min TV</div></div>' +
      '<div class="completion-reward"><span class="reward-amount">' + comp.tvEarned + ' min</span>' +
      '<input type="checkbox" class="claim-checkbox" ' + (comp.claimed ? 'checked' : '') + '></div>';
    item.querySelector('.claim-checkbox').addEventListener('change', function() {
      Storage.markClaimed(state.currentLessonId, comp.id, this.checked); renderLessonReview();
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
// PRACTICE - SECTION PIPELINE
// ============================================
function getCurrentSection() { return SECTIONS[state.sectionIdx]; }
function getCurrentPhrase() { return state.phrases[state.phraseOrder[state.phraseOrderIdx]]; }
function getCurrentChar() { return getCurrentPhrase()[state.currentCharIdx]; }
function getCurrentPhraseIdx() { return state.phraseOrder[state.phraseOrderIdx]; }

async function startLesson(lessonId) {
  const lesson = Storage.getLesson(lessonId); if (!lesson) return;
  state.currentLessonId = lessonId;
  state.phrases = lesson.phrases.slice();
  state.scores = {};
  state.phrases.forEach((_, i) => { state.scores[i] = {}; });

  // Fetch dict data for all unique characters
  const allChars = [...new Set(state.phrases.join('').split(''))].filter(c => CJK_REGEX.test(c));
  await fetchDictData(allChars);

  navigateTo('practice', lesson.name);
  renderSectionTabs();
  startSection(0);
}

function renderSectionTabs() {
  els.sectionTabs.innerHTML = '';
  SECTIONS.forEach((sec, i) => {
    const tab = document.createElement('div');
    tab.className = 'section-tab' + (i === state.sectionIdx ? ' active' : '') + (i < state.sectionIdx ? ' completed' : '');
    tab.textContent = sec.name;
    els.sectionTabs.appendChild(tab);
  });
}

function startSection(idx) {
  state.sectionIdx = idx;
  const sec = getCurrentSection();

  // Build phrase order
  state.phraseOrder = state.phrases.map((_, i) => i);
  if (sec.randomize) {
    for (let i = state.phraseOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.phraseOrder[i], state.phraseOrder[j]] = [state.phraseOrder[j], state.phraseOrder[i]];
    }
  }
  state.phraseOrderIdx = 0;
  renderSectionTabs();
  updateControls();
  startPhrase();
}

function startPhrase() {
  state.currentCharIdx = 0;
  state.roundNum = 1;
  state.guidedTotal = getCurrentSection().rounds || 1;
  state.tingxieCharResults = [];
  state.isAnimating = false;

  destroyWriters();
  updatePracticeUI();
  startCharacter();
}

function startCharacter() {
  const sec = getCurrentSection();
  const char = getCurrentChar();
  const phrase = getCurrentPhrase();

  updatePracticeUI();
  updateCharDetails();

  // Reference area
  if (sec.showRef) {
    els.refArea.classList.remove('hidden');
    els.tingxieArea.classList.add('hidden');
    // Reference writer
    if (state.refWriter) state.refWriter.setCharacter(char);
    else state.refWriter = HanziWriter.create(els.refWriterTarget, char, {
      width: 80, height: 80, padding: 5, strokeColor: '#333', outlineColor: '#ccc',
      strokeAnimationSpeed: 1, delayBetweenStrokes: 300,
    });
  } else {
    els.refArea.classList.add('hidden');
    els.tingxieArea.classList.remove('hidden');
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
function onMistake(data) {
  flashFeedback('red');
  els.quizWriterTarget.classList.add('shake');
  setTimeout(() => els.quizWriterTarget.classList.remove('shake'), 400);
}

function onCharComplete(data) {
  if (state.isAnimating) return;
  state.isAnimating = true;
  const sec = getCurrentSection();
  const isGuided = sec.showOutline && state.roundNum <= state.guidedTotal;

  // For tingxie, track per-char results
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = (data.totalMistakes <= MAX_MISTAKES_UNGUIDED);
  }

  if (!isGuided && !sec.perCharScoring && data.totalMistakes > MAX_MISTAKES_UNGUIDED) {
    // Failed free trace
    state.isAnimating = false;
    els.failDialog.classList.remove('hidden');
    return;
  }

  // Advance to next character or next round
  showSuccessFlash(sec.perCharScoring ? '' : 'Nice!', () => {
    state.isAnimating = false;
    advanceAfterChar();
  });
}

function advanceAfterChar() {
  const phrase = getCurrentPhrase();
  if (state.currentCharIdx < phrase.length - 1) {
    // Next character in phrase
    state.currentCharIdx++;
    startCharacter();
  } else {
    // All characters done — round complete
    onRoundComplete();
  }
}

function onRoundComplete() {
  const sec = getCurrentSection();

  if (sec.id === 'guided' && state.roundNum < state.guidedTotal) {
    // More guided rounds
    state.roundNum++;
    state.currentCharIdx = 0;
    destroyWriters();
    startCharacter();
  } else if (sec.id === 'guided' && state.roundNum >= state.guidedTotal) {
    // Guided section done for this phrase — award points
    awardSectionPoints();
    advancePhrase();
  } else {
    // Free/tingxie — section done for this phrase
    awardSectionPoints();
    advancePhrase();
  }
}

function awardSectionPoints() {
  const sec = getCurrentSection();
  const pi = getCurrentPhraseIdx();

  if (sec.perCharScoring) {
    // Tingxie scoring
    const correct = state.tingxieCharResults.filter(Boolean).length;
    const total = getCurrentPhrase().length;
    state.scores[pi][sec.id] = (correct === total) ? 5 : correct;
  } else {
    state.scores[pi][sec.id] = sec.maxPoints;
  }
}

function advancePhrase() {
  if (state.phraseOrderIdx < state.phraseOrder.length - 1) {
    state.phraseOrderIdx++;
    destroyWriters();
    startPhrase();
  } else {
    // Section complete
    advanceSection();
  }
}

function advanceSection() {
  destroyWriters();
  if (state.sectionIdx < SECTIONS.length - 1) {
    startSection(state.sectionIdx + 1);
  } else {
    showResults();
  }
}

// ============================================
// SKIP
// ============================================
function skipCharacter() {
  if (state.isAnimating) return;
  const sec = getCurrentSection();

  // Mark character as skipped (0 points contribution)
  if (sec.perCharScoring) {
    state.tingxieCharResults[state.currentCharIdx] = false;
  }

  advanceAfterChar();
}

// ============================================
// CONTROLS
// ============================================
function updateControls() {
  const sec = getCurrentSection();
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
  // Temporarily switch to guided outline
  const char = getCurrentChar();
  createQuizWriter(char, true);
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
  const sec = getCurrentSection();
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
  const sec = getCurrentSection();
  const phrase = getCurrentPhrase();
  const pi = getCurrentPhraseIdx();

  // Phrase bar — left: progress, center: phrase chars, right: score
  els.phraseProgress.textContent = 'Phrase ' + (state.phraseOrderIdx + 1) + '/' + state.phrases.length;
  els.practiceScore.textContent = calcTotalScore() + ' pts';

  // Render phrase characters: current char black, others grey (hidden in tingxie)
  els.phraseCharsDisplay.innerHTML = '';
  if (sec.showRef) {
    for (let i = 0; i < phrase.length; i++) {
      const span = document.createElement('span');
      span.className = 'phrase-char' + (i === state.currentCharIdx ? ' active' : '');
      span.textContent = phrase[i];
      els.phraseCharsDisplay.appendChild(span);
    }
  }

  // Progress info
  if (sec.id === 'guided') {
    els.attemptDisplay.textContent = 'Round ' + state.roundNum + '/' + state.guidedTotal;
  } else if (sec.id === 'free') {
    const isGuided = state.roundNum <= state.guidedTotal && state.guidedTotal > 1;
    els.attemptDisplay.textContent = isGuided ? 'Guided ' + state.roundNum + '/' + state.guidedTotal : 'Free Trace';
  } else {
    els.attemptDisplay.textContent = '';
  }

  // Show guided button only in free trace when not already guided
  if (sec.id === 'free') {
    els.btnGuided.classList.remove('hidden');
  }
}

function calcTotalScore() {
  let total = 0;
  for (const pi in state.scores) {
    for (const sid in state.scores[pi]) {
      total += state.scores[pi][sid];
    }
  }
  return total;
}

function calcMaxScore() {
  return state.phrases.length * SECTIONS.reduce((s, sec) => s + sec.maxPoints, 0);
}

// ============================================
// RESULTS & REWARD
// ============================================
function showResults() {
  const total = calcTotalScore();
  const max = calcMaxScore();
  const lesson = Storage.getLesson(state.currentLessonId);
  const cycle = lesson.completions.length;
  const tvEarned = TV_REWARDS[Math.min(cycle, TV_REWARDS.length - 1)];

  Storage.addCompletion(state.currentLessonId, {
    cycle: cycle + 1, score: total, maxScore: max,
    tvEarned: tvEarned, claimed: false,
  });

  const balance = Storage.getUnclaimedBalance();
  els.scoreSummary.innerHTML =
    '<div class="score-big">' + total + ' / ' + max + '</div>' +
    '<div>Guided: ' + sectionTotal('guided') + ' · Free: ' + sectionTotal('free') + ' · 听写: ' + sectionTotal('tingxie') + '</div>';
  els.tvTimeDisplay.textContent = 'You earned ' + tvEarned + ' minutes!';
  els.tvTimeTotal.textContent = 'Balance: ' + balance + ' minutes';

  destroyWriters();
  navigateTo('reward', 'Lesson Complete!');
  launchConfetti();
}

function sectionTotal(sectionId) {
  let t = 0;
  for (const pi in state.scores) { t += (state.scores[pi][sectionId] || 0); }
  return t;
}

// ============================================
// DICTIONARY & PINYIN
// ============================================
function numPinyinToTone(s) {
  const tones = { a:'āáǎàa', e:'ēéěèe', i:'īíǐìi', o:'ōóǒòo', u:'ūúǔùu', v:'ǖǘǚǜü' };
  const m = s.match(/^([a-zü]+)(\d)$/i); if (!m) return s;
  let syl = m[1].toLowerCase().replace(/ü/g,'v');
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
      state.dictCache[ch] = { pinyin: py ? numPinyinToTone(py) : '—', meaning: def.split(/;\s*/).filter(Boolean).slice(0,2).join('; ') };
    } catch(e) { state.dictCache[ch] = { pinyin:'—', meaning:'—' }; }
  }));
}

function updateCharDetails() {
  const sec = getCurrentSection();
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
function launchConfetti() {
  const c=els.confettiContainer; c.innerHTML='';
  const colors=['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff8cc8','#a855f7'];
  for(let i=0;i<50;i++){const p=document.createElement('div');p.className='confetti-piece';
  p.style.setProperty('--x',Math.random()*100+'vw');p.style.setProperty('--delay',Math.random()*.8+'s');
  p.style.setProperty('--color',colors[i%colors.length]);p.style.setProperty('--drift',(Math.random()-.5)*200+'px');
  c.appendChild(p);} setTimeout(()=>{c.innerHTML='';},4000);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
